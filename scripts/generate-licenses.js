const fs = require('fs');

console.log('Generating license attribution files...');

try {
  const licenses = JSON.parse(fs.readFileSync('/build/licenses/nodejs/THIRD_PARTY_LICENSES.json'));
  let output = '# Third-Party Node.js Packages\n\n';

  Object.entries(licenses).sort().forEach(([pkg, info]) => {
    const [name, version] = pkg.includes('@') && !pkg.startsWith('@')
      ? pkg.split('@').slice(-2)
      : [pkg.split('@')[0], pkg.split('@')[1] || 'unknown'];

    output += `## ${name} ${version || info.version || ''}\n`;
    output += `- License: ${info.licenses || 'Unknown'}\n`;
    if (info.repository) output += `- Repository: ${info.repository}\n`;
    if (info.publisher) output += `- Publisher: ${info.publisher}\n`;
    if (info.email) output += `- Email: ${info.email}\n`;
    if (info.url) output += `- URL: ${info.url}\n`;

    if (info.licenseFile && fs.existsSync(info.licenseFile)) {
      try {
        const licenseText = fs.readFileSync(info.licenseFile, 'utf8');
        if (licenseText.trim()) {
          output += '\n<details><summary>License text</summary>\n\n';
          output += licenseText.trim();
          output += '\n</details>\n';
        }
      } catch (e) {
        console.warn(`Could not read license file for ${pkg}: ${e.message}`);
      }
    }
    output += '\n';
  });

  fs.writeFileSync('/build/licenses/nodejs/ATTRIBUTIONS.md', output);
  console.log('License attribution file generated successfully');

  const packageCount = Object.keys(licenses).length;
  const licenseTypes = [...new Set(Object.values(licenses).map(l => l.licenses))].sort();

  console.log(`Processed ${packageCount} packages`);
  console.log(`License types found: ${licenseTypes.join(', ')}`);

} catch (error) {
  console.error('Failed to generate license attribution:', error);
  process.exit(1);
}
