'use strict';

function collectorReadiness(manager) {
  const control = manager.sourceControl?.status() || null;
  const budget = manager.sourceBudget?.status() || null;
  const resources = manager.resourceGuard?.status({ fresh: true }) || null;
  const pauses = [control, budget, resources].filter((state) => state?.paused);
  let gate = control;
  if (pauses.length) {
    const deadlines = pauses.map((state) => Date.parse(state.notBefore)).filter(Number.isFinite);
    gate = {
      ...control,
      paused: true,
      manualRequired: Boolean(control?.manualRequired),
      reason: pauses
        .map((state) => state.reason)
        .filter(Boolean)
        .join('；'),
      notBefore: deadlines.length ? new Date(Math.max(...deadlines)).toISOString() : null,
    };
  }
  if (manager.manualRecovery?.active)
    gate = { ...gate, paused: true, manualRequired: true, reason: '管理员正在处理来源验证' };
  return { sourceControl: gate, sourceBudget: budget, resources };
}

module.exports = { collectorReadiness };
