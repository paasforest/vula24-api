/**
 * Generates a Vula24 customer code for a locksmith.
 * Format: VL-YEAR-PROVINCE-NUMBER
 * Example: VL-2025-GP-001
 *
 * @param {string} province - 2-letter province code (e.g. "GP", "WC")
 * @param {number} id - Locksmith database ID (used as the sequence number)
 * @returns {string} Customer code
 */
function generateCustomerCode(province, id) {
  const year = new Date().getFullYear();
  const prov = (province || "XX").toUpperCase().trim();
  const number = String(id).padStart(3, "0");
  return `VL-${year}-${prov}-${number}`;
}

module.exports = { generateCustomerCode };
