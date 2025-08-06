
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const { lookup } = require('mime-types');

const { getInput, setFailed } = require('@actions/core');
const { BlobServiceClient } = require('@azure/storage-blob');

const { XMLParser } = require('fast-xml-parser');

async function* listFiles(rootFolder){

    const readdir = promisify(fs.readdir);

    const listFilesAsync = async function* (parentFolder){
        const statSync = fs.statSync(parentFolder);
        if(statSync.isFile()){
            yield parentFolder;
        }
        else if (statSync.isDirectory()){
            const files = await readdir(parentFolder); 
            for (const file of files){
                const fileName = path.join(parentFolder, file);
                yield *listFilesAsync(fileName);
            }
        }
    }

    yield *listFilesAsync(rootFolder);
}

async function uploadFileToBlob(containerService, fileName, blobName){

    var blobClient = containerService.getBlockBlobClient(blobName);
    var blobContentType = lookup(fileName) || 'application/octet-stream';
    await blobClient.uploadFile(fileName, { blobHTTPHeaders: { blobContentType } });

    console.log(`The file ${fileName} was uploaded as ${blobName}, with the content-type of ${blobContentType}`);
}

function checkSubfolderExclusion(folderName, target, blob) {
    if(folderName.indexOf(',') >= 0) {
        var exclusionFlag = false;
        var folderNameArray = folderName.split(',').map(function(value) {
            return value.trim();
        });

        folderNameArray.forEach(theFolderName => {
            if(blob.name.startsWith(target + `${theFolderName}/`)){
                exclusionFlag = true;
            }
        });
        return exclusionFlag;
    } else {
        return blob.name.startsWith(target + `${folderName}/`);
    }
}

function millisToMinutesAndSeconds(millis) {
    var minutes = Math.floor(millis / 60000);
    var seconds = ((millis % 60000) / 1000).toFixed(0);
    return minutes + "m " + (seconds < 10 ? '0' : '') + seconds + "s";
}

async function copyBlob(
    containerService, 
    sourceBlobContainerName, 
    sourceBlobName, 
    destinationBlobContainerName,
    destinationBlobName) {

    // create container clients
    const sourceContainerClient = containerService.getContainerClient(sourceBlobContainerName); 
    const destinationContainerClient = containerService.getContainerClient(destinationBlobContainerName);   
    
    // create blob clients
    const sourceBlobClient = await sourceContainerClient.getBlobClient(sourceBlobName);
    const destinationBlobClient = await destinationContainerClient.getBlobClient(destinationBlobName);

    // start copy
    const copyPoller = await destinationBlobClient.beginCopyFromURL(sourceBlobClient.url);

    console.log(`copying file ${sourceBlobName} to ${destinationBlobName}`);
    // wait until done
    await copyPoller.pollUntilDone();
}

const main = async () => {
    let UID = (new Date().valueOf()).toString();
    let uploadStart;
    let uploadEnd; 
    let copySubFolderStart;
    let copySubFolderEnd; 
    let deleteTargetStart;
    let deleteTargetEnd;
    let copyStart;
    let copyEnd; 
    let deleteTempStart;
    let deleteTempEnd; 
    
    const connectionString = getInput('connection-string');
    if (!connectionString) {
        throw "Connection string must be specified!";
    }

    const enableStaticWebSite = getInput('enabled-static-website');
    const containerName = (enableStaticWebSite) ? "$web" : getInput('blob-container-name') ;
    if (!containerName) {
        throw "Either specify a container name, or set enableStaticWebSite to true!";
    }

    const source = getInput('source');
    let target = getInput('target');
    if (target.startsWith('/')) target = target.slice(1);
    let targetUID = '/';

    if(!target) {
        targetUID = UID;
    } else if (target !== '/'){
        targetUID = path.join(target, '..', UID);
    }

    const accessPolicy = getInput('public-access-policy');
    const indexFile = getInput('index-file') || 'index.html';
    const errorFile = getInput('error-file');
    const removeExistingFiles = getInput('remove-existing-files');
    const excludeSubfolder = getInput('exclude-subfolder');

    const blobServiceClient = await BlobServiceClient.fromConnectionString(connectionString);

    if (enableStaticWebSite) {
        var props = await blobServiceClient.getProperties();

        props.cors = props.cors || [];
        props.staticWebsite.enabled = true;
        if(!!indexFile){
            props.staticWebsite.indexDocument = indexFile;
        }
        if(!!errorFile){
            props.staticWebsite.errorDocument404Path = errorFile;
        }
        await blobServiceClient.setProperties(props);
    }

    const containerService = blobServiceClient.getContainerClient(containerName);
    if (!await containerService.exists()) {
        await containerService.create({ access: accessPolicy });
    }
    else {
        await containerService.setAccessPolicy(accessPolicy);
    }

    const rootFolder = path.resolve(source);

    // (async () => {
    // const response = await fetch('https://main--adp-devsite--adobedocs.aem.page/sitemap.xml');
    // const xmlData = await response.text();

    // const parser = new XMLParser();
    // const sitemap = parser.parse(xmlData);

    // console.log(sitemap);
    // })();

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

            // console.log(updatedUrls);
            return updatedUrls;

        } catch (error) {
            console.error('Error fetching sitemap:', error);
            throw error;
        }
    }

    fetchEDSSitemap();

    // Collect page data instead of just logging it
    const pageData = [];
    
    for await (const blob of containerService.listBlobsFlat()) {
        // only consider blobs ending in "index.html"
        if (!blob.name.endsWith("index.html")) continue;
        const route = blob.name.slice(0, -"index.html".length);
        if (route.endsWith("404/")) continue;
        // tranform blob.properties.lastModified:
        const rawDate       = blob.properties.lastModified;
        const lastModified  = rawDate.toISOString().split('T')[0]; // "YYYY-MM-DD"
        const pageInfo = `${siteUrl}${route}`;

        // const pageInfo = `PageURL: ${siteUrl}${route}  LastModified: ${lastModified}`;
        console.log(pageInfo);
        // pageData.push(pageInfo);
    }

    // Create a file with the collected data and upload to blob storage
    // if (pageData.length > 0) {
    //     const pageDataContent = pageData.join('\n');
    //     const tempFilePath = path.join(__dirname, 'test-sitemap.txt');
        
    //     // Write to temporary file
    //     fs.writeFileSync(tempFilePath, pageDataContent);
        
    //     // Upload to root of blob storage (no path prefix since target is root)
    //     await uploadFileToBlob(containerService, tempFilePath, path.join(target, path.basename(tempFilePath)));
        
    //     // Clean up temporary file
    //     fs.unlinkSync(tempFilePath);
        
    //     console.log(`Uploaded page data file with ${pageData.length} entries to blob storage root`);
    // }

    // if(fs.statSync(rootFolder).isFile()){
    //     // when does this ever get called in the case of AdobeDocs?
    //     // seems to be if the pathPrefix is a file location then this uploads to that???
    //     return await uploadFileToBlob(containerService, rootFolder, path.join(target, path.basename(rootFolder)));
    // }
    // else{
    //     uploadStart = new Date();
    //     for await (const fileName of listFiles(rootFolder)) {
    //         var blobName = path.relative(rootFolder, fileName);
    //         await uploadFileToBlob(containerService, fileName, path.join(targetUID, blobName));
    //     }
    //     uploadEnd = new Date();
    // }

    // copySubFolderStart = new Date();
    // // move over excluded subfolders to temp location too
    // for await (const blob of containerService.listBlobsFlat({prefix: target})) {
    //     // make sure to get the excludeSubfolder and copy it
    //     if (excludeSubfolder !== '' && checkSubfolderExclusion(excludeSubfolder, target, blob)) {
    //         // get the split after target so we can just copy over just the excluded subfolders 
    //         let blobNameSplit =  blob.name.split(target)[1];
    //         console.log(`The file ${blob.name} is copying to ${path.join(targetUID, blobNameSplit)}`);

    //         await copyBlob(blobServiceClient, containerName, blob.name, containerName, path.join(targetUID, blobNameSplit));
    //     } 
    // }
    // copySubFolderEnd= new Date();

    // deleteTargetStart = new Date();

    // delete original target folder
    // if (!target) {
    //     for await (const blob of containerService.listBlobsFlat()){
    //         if (!blob.name.startsWith(targetUID)) {
    //             await containerService.deleteBlob(blob.name);
    //         }
    //     }
    // }
    // else {
    //     for await (const blob of containerService.listBlobsFlat({prefix: target})){
    //         if (blob.name.startsWith(target)) {
    //             console.log(`The file ${blob.name} is set for deletion`);
    //             await containerService.deleteBlob(blob.name);
    //         }
    //     }
    // }

    // deleteTargetEnd = new Date();
    // copyStart = new Date();

    // // copy temp foldr back to target
    // for await (const blob of containerService.listBlobsFlat({prefix: targetUID})){
    //     // get the split after targetUID
    //     let blobNameTargetUIDSplit =  blob.name.split(targetUID)[1];
    //     let copyBackToOriginalPath = path.join(target, blobNameTargetUIDSplit);
    //     if(!target) {
    //         if (blobNameTargetUIDSplit.startsWith('/')) blobNameTargetUIDSplit = blobNameTargetUIDSplit.slice(1);
    //         copyBackToOriginalPath = blobNameTargetUIDSplit;
    //     }
    //     await copyBlob(blobServiceClient, containerName, blob.name, containerName, copyBackToOriginalPath);
    // }

    // copyEnd = new Date();
    // deleteTempStart = new Date();

    // // delete temp folder
    // for await (const blob of containerService.listBlobsFlat({prefix: targetUID})){
    //     if (blob.name.startsWith(targetUID)) {
    //         console.log(`The file ${blob.name} is set for deletion`);
    //         await containerService.deleteBlob(blob.name);
    //     }
    // }

    // deleteTempEnd = new Date();
    // // millisToMinutesAndSeconds
    // console.log(`Upload took: ${millisToMinutesAndSeconds(uploadEnd - uploadStart)}`);
    // console.log(`Copy subfolder took: ${millisToMinutesAndSeconds(copySubFolderEnd - copySubFolderStart)}`);
    // console.log(`Deletion of original target folder took: ${millisToMinutesAndSeconds(deleteTargetEnd - deleteTargetStart)}`);
    // console.log(`Copy from temp to target folder took: ${millisToMinutesAndSeconds(copyEnd - copyStart)}`);
    // console.log(`Deletion of temp folder took: ${millisToMinutesAndSeconds(deleteTempEnd - deleteTempStart)}`);
};

main().catch(err => {
    console.error(err);
    console.error(err.stack);
    setFailed(err);
    process.exit(-1);
})