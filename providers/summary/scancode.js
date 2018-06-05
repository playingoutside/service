// Copyright (c) Microsoft Corporation and others. Licensed under the MIT license.
// SPDX-License-Identifier: MIT

const { get, remove, set } = require('lodash')
const minimatch = require('minimatch')

class ScanCodeSummarizer {
  constructor(options) {
    this.options = options
  }

  /**
   * Summarize the raw information related to the given coordinates using the supplied facet info to
   * bucketize results. If `facets` is falsy, only return the extracted `facets` portion of the raw
   * data, if any.
   * @param {EntitySpec} coordinates - The entity for which we are summarizing
   * @param {*} harvested - the set of raw tool ouptuts related to the idenified entity
   * @param {Facets} foo - an object detailing the facets to group by.
   * @returns {Definition} - a summary of the given raw information
   */
  summarize(coordinates, harvested, facets = {}) {
    if (!harvested || !harvested.content || !harvested.content.scancode_version)
      throw new Error('Not valid ScanCode data')

    if (!facets)
      // ScanCode output never has facet info in it
      return {}
    const result = {}
    this.addDescribedInfo(result, coordinates, harvested)
    const buckets = this.computeFileBuckets(harvested.content.files, facets)
    set(result, 'licensed.facets', {})
    const facetsObject = get(result, 'licensed.facets')
    const declaredLicenses = new Set()
    for (const key in buckets) {
      facetsObject[key] = this.summarizeLicenseInfo(buckets[key])
      this.summarizeDeclaredLisense(buckets[key], declaredLicenses)
    }
    set(result, 'licensed.declared', this._toExpression(declaredLicenses))
    return result
  }

  computeFileBuckets(files, facets) {
    const facetList = Object.getOwnPropertyNames(facets)
    remove(facetList, 'core')
    if (facetList.length === 0) return { core: files }

    const result = {}
    for (const facet in facetList) {
      const facetKey = facetList[facet]
      const filters = facets[facetKey]
      if (!filters || filters.length === 0) break
      result[facetKey] = remove(files, file => filters.some(filter => minimatch(file.path, filter)))
    }
    result.core = files
    return result
  }

  addDescribedInfo(result, coordinates, harvested) {
    const releaseDate = harvested._metadata.releaseDate
    if (releaseDate) result.described = { releaseDate: releaseDate.trim() }
  }

  summarizeLicenseInfo(files) {
    const copyrightHolders = new Set()
    const licenseExpressions = new Set()
    const declaredLicenses = new Set()
    let unknownParties = 0
    let unknownLicenses = 0

    for (let file of files) {
      this._addArrayToSet(file.licenses, licenseExpressions, license => license.spdx_license_key)
      const asserted = get(file, 'packages[0].asserted_licenses')
      if (!asserted) {
        if (!file.licenses || file.licenses.length === 0) unknownLicenses++
        const hasHolders = this._normalizeCopyrights(file.copyrights, copyrightHolders)
        !hasHolders && unknownParties++
      }
    }

    return {
      attribution: {
        parties: this._setToArray(copyrightHolders),
        unknown: unknownParties
      },
      discovered: {
        expressions: this._setToArray(licenseExpressions),
        unknown: unknownLicenses
      },
      files: files.length
    }
  }

  summarizeDeclaredLisense(files, declaredLicenses) {
    files.forEach(file => {
      const asserted = get(file, 'packages[0].asserted_licenses')
      if (asserted) this._addArrayToSet(asserted, declaredLicenses, license => license.license || license.spdx_license_key)
      this._addLicenseFiles(file, declaredLicenses)
    })
  }

  _addLicenseFiles(file, declaredLicenses) {
    // Look for license files at the root of the scanned code
    // TODO enhance in the future to cover more license management strategies.
    const license = ['license', 'license.txt', 'license.md', 'license.html'].reduce((current, prefix) => {
      if (!current) return file.path.toLowerCase().includes(prefix)
      return current
    }, false)
    if (!license) return
    if (!file.licenses) return
    file.licenses.forEach(license => declaredLicenses.add(license.spdx_license_key))
  }

  _toExpression(licenses) {
    const list = this._setToArray(licenses)
    return list ? list.join(' and ') : null
  }

  _setToArray(licenses) {
    const result = Array.from(licenses)
      .filter(e => e)
      .sort()
    return result.length === 0 ? null : result
  }

  _normalizeCopyrights(copyrights, holders) {
    if (!copyrights || !copyrights.length) return false
    let hasHolders = false
    for (let copyright of copyrights) {
      this._addArrayToSet(copyright.holders, holders)
      hasHolders = hasHolders || copyright.holders.length
    }
    return hasHolders
  }

  _addArrayToSet(array, set, valueExtractor) {
    if (!array || !array.length) return

    valueExtractor = valueExtractor || (value => value)
    for (let entry of array) {
      set.add(valueExtractor(entry))
    }
  }
}

module.exports = options => new ScanCodeSummarizer(options)
