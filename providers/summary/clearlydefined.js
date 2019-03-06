// Copyright (c) Microsoft Corporation and others. Licensed under the MIT license.
// SPDX-License-Identifier: MIT

const { get, set, isArray, uniq, cloneDeep, flatten, find } = require('lodash')
const SPDX = require('../../lib/spdx')
const {
  extractDate,
  setIfValue,
  extractLicenseFromLicenseUrl,
  buildSourceUrl,
  isDeclaredLicense,
  isLicenseFile,
  updateSourceLocation,
  mergeDefinitions,
  buildUrls,
  buildDownloadUrl,
  buildRegistryUrl,
  buildVersionUrl
} = require('../../lib/utils')

class ClearlyDescribedSummarizer {
  constructor(options) {
    this.options = options
  }

  summarize(coordinates, data) {
    const result = {}
    this.addFacetInfo(result, data)
    this.addSourceLocation(result, data)
    this.addSummaryInfo(result, data)
    this.addFiles(result, data)
    this.addAttachedFiles(result, data, coordinates)
    this.addInterestingFiles(result, data, coordinates)
    this.addLicenseFromFiles(result, data, coordinates)
    switch (coordinates.type) {
      case 'npm':
        this.addNpmData(result, data, coordinates)
        break
      case 'crate':
        this.addCrateData(result, data, coordinates)
        break
      case 'maven':
        this.addMavenData(result, data, coordinates)
        break
      case 'sourcearchive':
        this.addSourceArchiveData(result, data, coordinates)
        break
      case 'nuget':
        this.addNuGetData(result, data, coordinates)
        break
      case 'gem':
        this.addGemData(result, data, coordinates)
        break
      case 'pod':
        this.addPodData(result, data, coordinates)
        break
      case 'pypi':
        this.addPyPiData(result, data, coordinates)
        break
      default:
    }
    return result
  }

  addSummaryInfo(result, data) {
    setIfValue(result, 'described.hashes', get(data, 'summaryInfo.hashes'))
    setIfValue(result, 'described.files', get(data, 'summaryInfo.count'))
  }

  addFacetInfo(result, data) {
    setIfValue(result, 'described.facets', data.facets)
  }

  addSourceLocation(result, data) {
    if (!data.sourceInfo) return
    const spec = data.sourceInfo
    updateSourceLocation(spec)
    spec.url = buildSourceUrl(spec)
    set(result, 'described.sourceLocation', spec)
  }

  addFiles(result, data) {
    if (!data.files) return
    result.files = data.files.map(file => {
      return { path: file.path, hashes: file.hashes }
    })
  }

  addAttachedFiles(result, data, coordinates) {
    if (!data.attachments || !result.files) return
    data.attachments.forEach(file => {
      const existing = result.files.find(entry => entry.path === file.path)
      if (!existing) return
      existing.token = file.token
      if (isLicenseFile(file.path, coordinates)) existing.natures = uniq((existing.natures || []).concat(['license']))
    })
  }

  /**
   * Deprecated in favor of attachments from when licensee was a part of the CD tool
   * TODO: remove when interestingFiles is no longer in harvested data
   */
  addInterestingFiles(result, data, coordinates) {
    if (!data.interestingFiles) return
    const newDefinition = cloneDeep(result)
    const newFiles = cloneDeep(data.interestingFiles)
    newFiles.forEach(file => {
      file.license = SPDX.normalize(file.license)
      if (!file.license) delete file.license
      else if (isLicenseFile(file.path, coordinates)) file.natures = uniq((file.natures || []).concat(['license']))
    })
    set(newDefinition, 'files', newFiles)
    mergeDefinitions(result, newDefinition)
  }

  /**
   * Deprecated in favor of attachments from when licensee was a part of the CD tool
   * TODO: remove when interestingFiles is no longer in harvested data
   */
  addLicenseFromFiles(result, data, coordinates) {
    if (!data.interestingFiles) return
    const licenses = data.interestingFiles
      .map(file => (isDeclaredLicense(file.license) && isLicenseFile(file.path, coordinates) ? file.license : null))
      .filter(x => x)
    setIfValue(result, 'licensed.declared', uniq(licenses).join(' AND '))
  }

  addMavenData(result, data, coordinates) {
    setIfValue(result, 'described.releaseDate', extractDate(data.releaseDate))
    setIfValue(result, 'described.urls', buildUrls(coordinates))
    const projectSummaryLicenses =
      get(data, 'manifest.summary.licenses') || get(data, 'manifest.summary.project.licenses') // the project layer was removed in 1.2.0
    if (!projectSummaryLicenses) return
    const licenseSummaries = flatten(projectSummaryLicenses.map(x => x.license))
    const licenseUrls = uniq(flatten(licenseSummaries.map(license => license.url)))
    const licenseNames = uniq(flatten(licenseSummaries.map(license => license.name)))
    let licenses = licenseUrls.map(extractLicenseFromLicenseUrl).filter(x => x)
    if (!licenses.length) licenses = licenseNames.map(x => SPDX.lookupByName(x) || x).filter(x => x)
    if (licenses.length) setIfValue(result, 'licensed.declared', SPDX.normalize(licenses.join(' OR ')))
  }

  addCrateData(result, data, coordinates) {
    setIfValue(result, 'described.releaseDate', extractDate(get(data, 'registryData.created_at')))
    setIfValue(result, 'described.projectWebsite', get(data, 'manifest.homepage'))
    const license = get(data, 'registryData.license')
    if (license) setIfValue(result, 'licensed.declared', SPDX.normalize(license.split('/').join(' OR ')))
    setIfValue(result, 'described.urls', buildUrls(coordinates))
  }

  addSourceArchiveData(result, data, coordinates) {
    setIfValue(result, 'described.releaseDate', extractDate(data.releaseDate))
    setIfValue(result, 'described.urls', buildUrls(coordinates))
  }

  addNuGetData(result, data, coordinates) {
    setIfValue(result, 'described.releaseDate', extractDate(data.releaseDate))
    const licenseExpression = SPDX.normalize(get(data, 'manifest.licenseExpression'))
    const licenseUrl = get(data, 'manifest.licenseUrl')
    if (licenseExpression) set(result, 'licensed.declared', licenseExpression)
    else if (licenseUrl && licenseUrl.trim())
      set(result, 'licensed.declared', extractLicenseFromLicenseUrl(licenseUrl) || 'NOASSERTION')
    setIfValue(result, 'described.urls', buildUrls(coordinates))
    const packageEntries = get(data, 'manifest.packageEntries')
    if (!packageEntries) return
    const newDefinition = cloneDeep(result)
    newDefinition.files = packageEntries.map(file => {
      return { path: decodeURIComponent(file.fullName) }
    })
    mergeDefinitions(result, newDefinition)
  }

  addNpmData(result, data, coordinates) {
    if (!data.registryData) return
    setIfValue(result, 'described.releaseDate', extractDate(data.registryData.releaseDate))
    setIfValue(result, 'described.urls', buildUrls(coordinates))
    const manifest = get(data, 'registryData.manifest')
    if (!manifest) return
    let homepage = manifest.homepage
    if (homepage && isArray(homepage)) homepage = homepage[0]
    setIfValue(result, 'described.projectWebsite', homepage)
    const bugs = manifest.bugs
    if (bugs) {
      if (typeof bugs === 'string') {
        if (bugs.startsWith('http')) setIfValue(result, 'described.issueTracker', bugs)
      } else setIfValue(result, 'described.issueTracker', bugs.url || bugs.email)
    }
    const license =
      manifest.license &&
      SPDX.normalize(typeof manifest.license === 'string' ? manifest.license : manifest.license.type)
    setIfValue(result, 'licensed.declared', license)
  }

  addPodData(result, data, coordinates) {
    setIfValue(result, 'described.releaseDate', extractDate(data.releaseDate))
    setIfValue(result, 'described.projectWebsite', get(data, 'registryData.homepage'))
    const license = get(data, 'registryData.license')
    if (license) {
      setIfValue(result, 'licensed.declared', SPDX.normalize(typeof license === 'string' ? license : license.type))
    }

    const homepage = get(data, 'registryData.homepage')
    const revision = get(data, 'registryData.sourceInfo.revision')

    const registry = buildRegistryUrl(coordinates)
    const version = homepage && revision ? `${homepage}/tree/${revision}` : null
    const download = homepage && revision ? `${homepage}/archive/${revision}.zip` : null
    setIfValue(result, 'described.urls', { registry, version, download })
  }

  addGemData(result, data, coordinates) {
    setIfValue(result, 'described.releaseDate', extractDate(data.releaseDate))
    const license = SPDX.normalize(get(data, 'registryData.license'))
    if (license) set(result, 'licensed.declared', license)
    else {
      const licenses = SPDX.normalize((get(data, 'registryData.licenses') || []).join(' OR '))
      setIfValue(result, 'licensed.declared', licenses)
    }
    setIfValue(result, 'described.urls', buildUrls(coordinates))
  }

  addPyPiData(result, data, coordinates) {
    setIfValue(result, 'described.releaseDate', extractDate(data.releaseDate))
    setIfValue(result, 'licensed.declared', data.declaredLicense)
    const releases = get(data, 'registryData.releases')
    // TODO: we are currently picking the first url that contains a tar.gz extension
    // we should understand what's the correct process on a pypi definition that contains multiple object for the same release
    const revision = find(releases[coordinates.revision], revision => revision.filename.includes('tar.gz'))
    const registry = buildRegistryUrl(coordinates)
    const version = buildVersionUrl(coordinates)
    setIfValue(result, 'described.urls', { registry, version, download: revision.url })
  }
}

module.exports = options => new ClearlyDescribedSummarizer(options)
