import * as path from 'path';
import * as url from 'url';
import { promises as fs } from 'fs';
import { recursiveDirectoryCopy } from '@zoltu/file-copier';
import { createHash } from 'node:crypto';
const directoryOfThisFile = path.dirname(url.fileURLToPath(import.meta.url));
const dependencyPaths = [
    { packageName: 'ethers', subfolderToVendor: 'dist', entrypointFile: 'ethers.js' },
    { packageName: 'webextension-polyfill', subfolderToVendor: 'dist', entrypointFile: 'browser-polyfill.js' },
    { packageName: 'preact', subfolderToVendor: 'dist', entrypointFile: 'preact.module.js' },
    { packageName: 'preact/jsx-runtime', subfolderToVendor: 'dist', entrypointFile: 'jsxRuntime.module.js' },
    { packageName: 'preact/hooks', subfolderToVendor: 'dist', entrypointFile: 'hooks.module.js' },
    { packageName: 'funtypes', subfolderToVendor: 'lib', entrypointFile: 'index.mjs' },
    { packageName: 'node-fetch', subfolderToVendor: 'lib', entrypointFile: 'index.mjs' },
    { packageName: '@noble/hashes/crypto', packageToVendor: '@noble/hashes', subfolderToVendor: 'esm', entrypointFile: 'cryptoBrowser.js' },
    { packageName: '@noble/hashes/sha3', packageToVendor: '@noble/hashes', subfolderToVendor: 'esm', entrypointFile: 'sha3.js' },
    { packageName: '@noble/hashes/sha256', packageToVendor: '@noble/hashes', subfolderToVendor: 'esm', entrypointFile: 'sha256.js' },
    { packageName: '@noble/hashes/sha512', packageToVendor: '@noble/hashes', subfolderToVendor: 'esm', entrypointFile: 'sha512.js' },
    { packageName: '@noble/hashes/blake2s', packageToVendor: '@noble/hashes', subfolderToVendor: 'esm', entrypointFile: 'blake2s.js' },
    { packageName: '@noble/hashes/utils', packageToVendor: '@noble/hashes', subfolderToVendor: 'esm', entrypointFile: 'utils.js' },
    { packageName: '@noble/hashes/hmac', packageToVendor: '@noble/hashes', subfolderToVendor: 'esm', entrypointFile: 'hmac.js' },
    { packageName: '@noble/curves/secp256k1', packageToVendor: '@noble/secp256k1', subfolderToVendor: '', entrypointFile: 'index.js' },
    { packageName: '@noble/curves/stark', packageToVendor: '@noble/curves', subfolderToVendor: '', entrypointFile: 'stark.js' },
    { packageName: '@darkflorist/address-metadata', subfolderToVendor: 'lib', entrypointFile: 'index.js' },
];
async function vendorDependencies(files) {
    for (const { packageName, packageToVendor, subfolderToVendor } of dependencyPaths) {
        const sourceDirectoryPath = path.join(directoryOfThisFile, '..', 'node_modules', packageToVendor || packageName, subfolderToVendor);
        const destinationDirectoryPath = path.join(directoryOfThisFile, '..', 'app', 'vendor', packageName);
        async function inclusionPredicate(path, fileType) {
            if (path.endsWith('.js'))
                return true;
            if (path.endsWith('.ts'))
                return true;
            if (path.endsWith('.mjs'))
                return true;
            if (path.endsWith('.mts'))
                return true;
            if (path.endsWith('.map'))
                return true;
            if (path.endsWith('.git') || path.endsWith('.git/') || path.endsWith('.git\\'))
                return false;
            if (path.includes('address-metadata/lib/images') || path.includes('address-metadata\\lib\\images'))
                return true;
            if (path.endsWith('node_modules') || path.endsWith('node_modules/') || path.endsWith('node_modules\\'))
                return false;
            if (fileType === 'directory')
                return true;
            return false;
        }
        await recursiveDirectoryCopy(sourceDirectoryPath, destinationDirectoryPath, inclusionPredicate, rewriteSourceMapSourcePath.bind(undefined, packageName));
    }
    const importmap = dependencyPaths.reduce((importmap, { packageName, entrypointFile }) => {
        importmap.imports[packageName] = `../${path.join('.', 'vendor', packageName, entrypointFile).replace(/\\/g, '/')}`;
        return importmap;
    }, { imports: {} });
    const importmapJson = `\n${JSON.stringify(importmap, undefined, '\t')
        .replace(/^/mg, '\t\t')}\n\t\t`;
    // replace in files
    for (const file of files) {
        const indexHtmlPath = path.join(directoryOfThisFile, '..', 'app', file);
        const oldIndexHtml = await fs.readFile(indexHtmlPath, 'utf8');
        const newIndexHtml = oldIndexHtml.replace(/<script type = 'importmap'>[\s\S]*?<\/script>/m, `<script type = 'importmap'>${importmapJson}</script>`);
        await fs.writeFile(indexHtmlPath, newIndexHtml);
    }
    // update the new hash to manifest.json
    const base64EncodedSHA256 = createHash('sha256').update(importmapJson).digest('base64');
    const manifestLocation = path.join(directoryOfThisFile, '..', 'app', 'manifestV2.json');
    const oldManifest = await fs.readFile(manifestLocation, 'utf8');
    const newManifest = oldManifest.replace(/sha256-[\s\S]*?'/m, `sha256-${base64EncodedSHA256}'`);
    await fs.writeFile(manifestLocation, newManifest);
}
// rewrite the source paths in sourcemap files so they show up in the debugger in a reasonable location and if two source maps refer to the same (relative) path, we end up with them distinguished in the browser debugger
async function rewriteSourceMapSourcePath(packageName, sourcePath, destinationPath) {
    const fileExtension = path.extname(sourcePath);
    if (fileExtension !== '.map')
        return;
    const fileContents = JSON.parse(await fs.readFile(sourcePath, 'utf-8'));
    for (let i = 0; i < fileContents.sources.length; ++i) {
        // we want to ensure all source files show up in the appropriate directory and don't leak out of our directory tree, so we strip leading '../' references
        const sourcePath = fileContents.sources[i].replace(/^(?:.\/)*/, '').replace(/^(?:..\/)*/, '');
        fileContents.sources[i] = ['dependencies://dependencies', packageName, sourcePath].join('/');
    }
    await fs.writeFile(destinationPath, JSON.stringify(fileContents));
}
const files = [
    'html/background.html',
    'html/popup.html',
    'html/confirmTransaction.html',
    'html/personalSign.html',
    'html/interceptorAccess.html',
    'html/changeChain.html',
    'html/addressBook.html',
];
vendorDependencies(files).catch(error => {
    console.error(error);
    debugger;
    process.exit(1);
});
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoidmVuZG9yLm1qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbInZlbmRvci5tdHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsT0FBTyxLQUFLLElBQUksTUFBTSxNQUFNLENBQUE7QUFDNUIsT0FBTyxLQUFLLEdBQUcsTUFBTSxLQUFLLENBQUE7QUFDMUIsT0FBTyxFQUFFLFFBQVEsSUFBSSxFQUFFLEVBQUUsTUFBTSxJQUFJLENBQUE7QUFDbkMsT0FBTyxFQUFZLHNCQUFzQixFQUFFLE1BQU0sb0JBQW9CLENBQUE7QUFDckUsT0FBTyxFQUFFLFVBQVUsRUFBRSxNQUFNLGFBQWEsQ0FBQTtBQUV4QyxNQUFNLG1CQUFtQixHQUFHLElBQUksQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDLGFBQWEsQ0FBQyxNQUFNLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUE7QUFFNUUsTUFBTSxlQUFlLEdBQUc7SUFDdkIsRUFBRSxXQUFXLEVBQUUsUUFBUSxFQUFFLGlCQUFpQixFQUFFLE1BQU0sRUFBRSxjQUFjLEVBQUUsV0FBVyxFQUFFO0lBQ2pGLEVBQUUsV0FBVyxFQUFFLHVCQUF1QixFQUFFLGlCQUFpQixFQUFFLE1BQU0sRUFBRSxjQUFjLEVBQUUscUJBQXFCLEVBQUU7SUFDMUcsRUFBRSxXQUFXLEVBQUUsUUFBUSxFQUFFLGlCQUFpQixFQUFFLE1BQU0sRUFBRSxjQUFjLEVBQUUsa0JBQWtCLEVBQUU7SUFDeEYsRUFBRSxXQUFXLEVBQUUsb0JBQW9CLEVBQUUsaUJBQWlCLEVBQUUsTUFBTSxFQUFFLGNBQWMsRUFBRSxzQkFBc0IsRUFBRTtJQUN4RyxFQUFFLFdBQVcsRUFBRSxjQUFjLEVBQUUsaUJBQWlCLEVBQUUsTUFBTSxFQUFFLGNBQWMsRUFBRSxpQkFBaUIsRUFBRTtJQUM3RixFQUFFLFdBQVcsRUFBRSxVQUFVLEVBQUUsaUJBQWlCLEVBQUUsS0FBSyxFQUFFLGNBQWMsRUFBRSxXQUFXLEVBQUU7SUFDbEYsRUFBRSxXQUFXLEVBQUUs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