#!/usr/bin/env node
/**
 * License Attribution Verification Script
 *
 * Verifies that all production dependencies from package.json are properly
 * attributed in the container's license files.
 */

const fs = require('fs');
const path = require('path');

function getExpectedDepsFromPackageJson() {
  try {
    const packageJsonPath = path.join(process.cwd(), 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      return packageJson.dependencies || {};
    }
  } catch (error) {
    console.warn('Could not read package.json, using empty list');
  }
  return {};
}

const expectedDeps = getExpectedDepsFromPackageJson();

console.log('Verifying license attribution completeness...\n');

try {
  const licenses = JSON.parse(fs.readFileSync('/build/licenses/nodejs/THIRD_PARTY_LICENSES.json'));

  const attributedPackages = Object.keys(licenses).map(pkg => {
    if (pkg.startsWith('@')) {
      const parts = pkg.split('@');
      return '@' + parts[1];
    }
    return pkg.split('@')[0];
  });

  const uniqueAttributedPackages = [...new Set(attributedPackages)];

  console.log(`Attribution Statistics:`);
  console.log(`   - Total attributed packages: ${Object.keys(licenses).length}`);
  console.log(`   - Unique package names: ${uniqueAttributedPackages.length}`);
  console.log(`   - Expected production deps: ${Object.keys(expectedDeps).length}\n`);

  const missing = [];
  const found = [];

  for (const [depName] of Object.entries(expectedDeps)) {
    if (uniqueAttributedPackages.includes(depName)) {
      found.push(depName);
      console.log(`  OK ${depName}`);
    } else {
      missing.push(depName);
      console.log(`  MISSING ${depName}`);
    }
  }

  console.log(`\nSummary:`);
  console.log(`   - Found: ${found.length}/${Object.keys(expectedDeps).length}`);
  console.log(`   - Missing: ${missing.length}`);

  // Check for problematic license types
  const allLicenses = Object.values(licenses).map(pkg => pkg.licenses);
  const uniqueLicenses = [...new Set(allLicenses)].sort();
  const problematicLicenses = [];

  for (const license of uniqueLicenses) {
    if (license && (
      license.toLowerCase().includes('gpl') ||
      license.toLowerCase().includes('agpl') ||
      license.toLowerCase().includes('copyleft')
    )) {
      problematicLicenses.push(license);
    }

    if (license === 'UNLICENSED') {
      const unlicensedPackages = Object.entries(licenses)
        .filter(([, info]) => info.licenses === 'UNLICENSED')
        .filter(([pkg]) => !pkg.startsWith('notary-arweave-bundler@'));

      if (unlicensedPackages.length > 0) {
        problematicLicenses.push(`UNLICENSED (${unlicensedPackages.length} packages)`);
      }
    }
  }

  if (problematicLicenses.length > 0) {
    console.log(`\nWARNING: Found potentially problematic licenses:`);
    problematicLicenses.forEach(license => console.log(`   - ${license}`));
    console.log(`   Please review these manually for compliance.`);
  }

  console.log(`\nLicense types in use: ${uniqueLicenses.join(', ')}`);

  if (missing.length === 0) {
    console.log(`\nSUCCESS: All expected dependencies are properly attributed!`);
    console.log(`Total attribution coverage: ${Object.keys(licenses).length} packages`);
    process.exit(0);
  } else {
    console.log(`\nINCOMPLETE: ${missing.length} dependencies missing attribution`);
    console.log(`   This may indicate a build or dependency resolution issue.`);
    process.exit(1);
  }

} catch (error) {
  console.error('Error reading license file:', error.message);
  process.exit(1);
}
