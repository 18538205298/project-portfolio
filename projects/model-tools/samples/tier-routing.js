// 原模型路由中的档位选择片段；CFG 由原服务提供。
function getTiers() { return CFG.models.tiers || []; }
function getTierIndex(model) {
  const tiers = getTiers();
  return tiers.findIndex(t => t.model === model);
}
function getNextTier(model) {
  const tiers = getTiers();
  const idx = tiers.findIndex(t => t.model === model);
  return (idx >= 0 && idx < tiers.length - 1) ? tiers[idx + 1].model : null;
}
function getPrevTier(model) {
  const tiers = getTiers();
  const idx = tiers.findIndex(t => t.model === model);
  return (idx > 0) ? tiers[idx - 1].model : null;
}
function getTopModel() {
  const tiers = getTiers();
  return tiers.length > 0 ? tiers[0].model : null;
}
