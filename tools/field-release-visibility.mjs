// BP-06: presentation-only eligibility; never use this filtered list to build upgrade chains.
import { currentVersion } from './release-workflow.mjs';

export function showReleaseForHospital(batch, customer) {
  const product = customer?.products?.find(p => p.project === batch.product);
  if (!product) return true; // Existing ticket access / first installation stays unchanged.
  let from;
  try { from = currentVersion(product); } catch { return true; }
  const to = String(batch.pkgVersion || '').trim();
  if (!to || !from) return true;
  if (to === from) return false;
  // Existing version ordering is numeric localeCompare. Only compare numeric version
  // families; custom tags / hotfix suffixes have no defined ordering and stay visible.
  const numeric = /^v?\d+(?:\.\d+)*$/i;
  if (!numeric.test(to) || !numeric.test(from)) return true;
  return to.replace(/^v/i, '').localeCompare(from.replace(/^v/i, ''), undefined, { numeric: true }) > 0;
}
