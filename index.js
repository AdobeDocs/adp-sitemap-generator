
const fs = require('fs');
const path = require('path');
const { getInput, setFailed } = require('@actions/core');
const { BlobServiceClient } = require('@azure/storage-blob');
const { XMLParser, XMLBuilder } = require('fast-xml-parser');

const main = async () => {    
    const connectionStringRead = getInput('connection-string-non-main'); // to read from
    const connectionStringPublish = getInput('connection-string-main'); // to write to

    if (!connectionStringRead) {
        throw "Connection string non main must be specified!";
    }

    if (!connectionStringPublish) {
        throw "Connection string main must be specified!";
    }

    const enableStaticWebSite = getInput('enabled-static-website');
    const containerName = (enableStaticWebSite) ? "$web" : getInput('blob-container-name') ;
    if (!containerName) {
        throw "Either specify a container name, or set enableStaticWebSite to true!";
    }

    const source = getInput('source');
    let target = getInput('target');
    if (target.startsWith('/')) target = target.slice(1);

    const accessPolicy = getInput('public-access-policy');
    const indexFile = getInput('index-file') || 'index.html';
    const errorFile = getInput('error-file');

    // Setup blob service clients for reading and publishing
    const blobServiceClientRead = await BlobServiceClient.fromConnectionString(connectionStringRead);
    const blobServiceClientPublish = await BlobServiceClient.fromConnectionString(connectionStringPublish);

    if (enableStaticWebSite) {
        var props = await blobServiceClientPublish.getProperties();

        props.cors = props.cors || [];
        props.staticWebsite.enabled = true;
        if(!!indexFile){
            props.staticWebsite.indexDocument = indexFile;
        }
        if(!!errorFile){
            props.staticWebsite.errorDocument404Path = errorFile;
        }
        await blobServiceClientPublish.setProperties(props);
    }

    // Setup container clients for both read and publish
    const containerServiceRead = blobServiceClientRead.getContainerClient(containerName);
    const containerServicePublish = blobServiceClientPublish.getContainerClient(containerName);
    
    if (!await containerServicePublish.exists()) {
        await containerServicePublish.create({ access: accessPolicy });
    }
    else {
        await containerServicePublish.setAccessPolicy(accessPolicy);
    }

    const rootFolder = path.resolve(source);

    const parser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: '_',
    });

    const EXCLUDED_PATTERNS = [
        /^\/test\//,                  // starts with /test/
        /^\/franklin_assets\//,       // starts with /franklin_assets/
        /^\/tools\//,                 // starts with /tools/
        /\/nav$/,                     // ends with /nav
        /^\/github-actions-test\//,   // starts with /github-actions-test/
        /\/config\/?$/                // ends with /config/ or /config
    ];

    function shouldIncludeUrl(url) {
        return !EXCLUDED_PATTERNS.some(pattern => pattern.test(new URL(url).pathname));
    }

    const siteUrl = "https://developer.adobe.com/";

    async function fetchEDSSitemap() {
        try {
            const response = await fetch('https://main--adp-devsite--adobedocs.aem.page/sitemap.xml');
            if (!response.ok) {
            throw new Error(`Failed to fetch sitemap: ${response.statusText}`);
            }

            const xmlText = await response.text();
            const result = parser.parse(xmlText);

            // Ensure we have URLs to process
            if (!result.urlset?.url) {
            throw new Error('No URLs found in sitemap');
            }

            const filteredUrls = result.urlset.url.filter(url => shouldIncludeUrl(url.loc));

            const updatedUrls = filteredUrls.map(url => {
                return {
                    ...url,
                    loc: url.loc.replace("https://main--adp-devsite--adobedocs.aem.page/", siteUrl)
                };
            });

            return updatedUrls;

        } catch (error) {
            console.error('Error fetching sitemap:', error);
            throw error;
        }
    }

    // list taken from active sites on Fastly - need to keep updated
    const EXCLUDED_PRIVATE_SITES = [
        "adls-beta", 
        "avatar-tts-beta",
        "custom-model-apis",
        "express-add-ons-beta-docs",
        "express-api",
        "firefly-beta",
        "photoshop-api-beta",
        "reframev2",
        "s3dapi",
        "secured",
        "taas-api",
        "ttv-api",
        "ucm-api",
        "video-reframe-api-beta",
        "video-rendering"
    ];

    // Collect page data instead of just logging it
    async function collectBlobPageData(containerServiceRead, siteUrl) {
        const urls = [];

        for await (const blob of containerServiceRead.listBlobsFlat()) {
            if (!blob.name.endsWith("index.html")) continue;

            const route = blob.name.slice(0, -"index.html".length);

            // 🚫 Skip if route starts ends with a 404 
            if (route.endsWith("404/")) continue;

            // 🚫 Skip if route starts with any excluded path (private/secured sites taken from fastly)
            if (EXCLUDED_PRIVATE_SITES.some(excluded => route.startsWith(`${excluded}/`))) continue;

            // 🚫 Skip if route contains a numeric segment longer than 9 digits (for the temp files created)
            const segments = route.split('/');
            const hasLongDigitSequence = segments.some(segment => /\d{9,}/.test(segment));
            if (hasLongDigitSequence) continue;

            const fullUrl = `${siteUrl}${route}`;

            // Check HTTP status and skip redirects and 404s
            try {
                const response = await fetch(fullUrl, { method: 'HEAD', redirect: 'manual' });

                // Skip if status is 404, 301, or 302
                if ([404, 301, 302].includes(response.status)){
                    continue;
                } 

                const rawDate = blob.properties.lastModified;
                const lastModified = rawDate.toISOString().split('T')[0];

                urls.push({
                    loc: fullUrl,
                    lastmod: lastModified
                });
            } catch (err) {
                console.warn(`Error fetching ${fullUrl}:`, err.message);
                continue;
            }
        }

    return urls;
}

    async function generateAndUploadSitemap(containerServicePublish, edsUrls, blobUrls) {
        const builder = new XMLBuilder({
            ignoreAttributes: false,
            format: true,
            suppressEmptyNode: true
        });

        const combinedUrls = [...edsUrls, ...blobUrls].map(({ loc, lastmod }) => ({
            loc,
            lastmod
        }));

        const sitemapObj = {
            urlset: {
                _xmlns: "http://www.sitemaps.org/schemas/sitemap/0.9",
                url: combinedUrls
            }
        };

        const sitemapXml = builder.build(sitemapObj);
        const sitemapBuffer = Buffer.from(sitemapXml, 'utf-8');

        const normalizedTarget = target === '/' ? '' : target.replace(/^\/+|\/+$/g, '');
        const blobName = normalizedTarget ? `${normalizedTarget}/sitemap.xml` : 'sitemap.xml';

        const blobClient = containerServicePublish.getBlockBlobClient(blobName);
        await blobClient.uploadData(sitemapBuffer, {
            blobHTTPHeaders: { blobContentType: "application/xml" }
        });

        console.log(`✅ Uploaded sitemap with ${combinedUrls.length} entries to: ${blobClient.url}`);
    }

    async function runSitemapWorkflow() {
        const edsUrls = await fetchEDSSitemap();
        const blobUrls = await collectBlobPageData(containerServiceRead, siteUrl);
        await generateAndUploadSitemap(containerServicePublish, edsUrls, blobUrls);
    }

    runSitemapWorkflow();
};

main().catch(err => {
    console.error(err);
    console.error(err.stack);
    setFailed(err);
    process.exit(-1);
})