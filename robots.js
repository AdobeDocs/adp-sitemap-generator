const path = require('path');
const fs = require('fs');
const { getInput, setFailed } = require('@actions/core');
const { BlobServiceClient } = require('@azure/storage-blob');

const main = async () => {
    const connectionString = getInput('connection-string-main');
    if (!connectionString) throw new Error('connection-string-main must be specified!');

    const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);

    const props = await blobServiceClient.getProperties();
    props.staticWebsite = props.staticWebsite || {};
    props.staticWebsite.enabled = true;
    await blobServiceClient.setProperties(props);

    const containerClient = blobServiceClient.getContainerClient('$web');
    if (!await containerClient.exists()) {
        await containerClient.create({ access: 'container' });
    }

    const robotsContent = fs.readFileSync(path.join(__dirname, 'robots.txt'));
    const blobClient = containerClient.getBlockBlobClient('robots.txt');
    await blobClient.uploadData(robotsContent, {
        blobHTTPHeaders: { blobContentType: 'text/plain' }
    });
    console.log(`Uploaded robots.txt to: ${blobClient.url}`);
};

main().catch(err => {
    console.error(err);
    process.exit(1);
});
