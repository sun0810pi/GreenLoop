const BIOMASS_TYPES = {
  rice_straw: {
    label: 'Rice straw',
    vi_label: 'Rơm rạ',
    season: 'wet_rice',
    carbon_factor: 3.12,
    yield_factor: 0.35,
    output: 'biochar',
    mrv_pathway: 'VM0044 biochar'
  },
  rice_husk: {
    label: 'Rice husk',
    vi_label: 'Vỏ trấu',
    season: 'wet_rice',
    carbon_factor: 3.12,
    yield_factor: 0.33,
    output: 'biochar',
    mrv_pathway: 'VM0044 biochar'
  },
  pond_sludge: {
    label: 'Aquaculture pond sludge',
    vi_label: 'Bùn ao thủy sản',
    season: 'dry_aquaculture',
    carbon_factor: 2.4,
    yield_factor: 0.28,
    output: 'biochar',
    mrv_pathway: 'VM0044 biochar with aquatic residue evidence'
  },
  shrimp_shells: {
    label: 'Shrimp shells',
    vi_label: 'Vỏ tôm',
    season: 'dry_aquaculture',
    carbon_factor: 0,
    yield_factor: 0,
    output: 'chitin',
    mrv_pathway: 'Bio-material traceability'
  },
  shrimp_heads: {
    label: 'Shrimp heads',
    vi_label: 'Đầu tôm',
    season: 'dry_aquaculture',
    carbon_factor: 0,
    yield_factor: 0,
    output: 'protein_bio_product',
    mrv_pathway: 'Bio-material traceability'
  },
  fish_skin_bones: {
    label: 'Fish skin and bones',
    vi_label: 'Da và xương cá',
    season: 'dry_aquaculture',
    carbon_factor: 0,
    yield_factor: 0,
    output: 'collagen_protein',
    mrv_pathway: 'Bio-material traceability'
  },
  melaleuca_leaves: {
    label: 'Melaleuca leaves',
    vi_label: 'Lá tràm',
    season: 'perennial_melaleuca',
    carbon_factor: 2.8,
    yield_factor: 0.30,
    output: 'biochar_or_extract',
    mrv_pathway: 'Biochar plus extract traceability'
  },
  melaleuca_branches: {
    label: 'Melaleuca branches',
    vi_label: 'Cành tràm',
    season: 'perennial_melaleuca',
    carbon_factor: 3.12,
    yield_factor: 0.32,
    output: 'LCNF',
    mrv_pathway: 'Cellulose material traceability'
  },
  melaleuca_thinning_wood: {
    label: 'Melaleuca thinning wood',
    vi_label: 'Gỗ tràm tỉa thưa',
    season: 'perennial_melaleuca',
    carbon_factor: 3.12,
    yield_factor: 0.34,
    output: 'LCNF',
    mrv_pathway: 'Cellulose material traceability'
  },
  melaleuca_residue: {
    label: 'Melaleuca residue',
    vi_label: 'Phụ phẩm tràm',
    season: 'perennial_melaleuca',
    carbon_factor: 2.8,
    yield_factor: 0.30,
    output: 'biochar_or_extract',
    mrv_pathway: 'Biochar plus extract traceability'
  },
  coconut_husk: {
    label: 'Coconut husk',
    vi_label: 'Vỏ dừa',
    season: 'perennial_biomass',
    carbon_factor: 3.0,
    yield_factor: 0.31,
    output: 'biochar_fiber',
    mrv_pathway: 'Biochar and fiber traceability'
  },
  coconut_water_residue: {
    label: 'Coconut water residue',
    vi_label: 'Bã dừa nước',
    season: 'forest_products',
    carbon_factor: 0,
    yield_factor: 0.22,
    output: 'fiber_feedstock',
    mrv_pathway: 'Bio-material traceability'
  },
  coffee_leaves: {
    label: 'Coffee leaves',
    vi_label: 'Lá cà phê',
    season: 'forest_products',
    carbon_factor: 0,
    yield_factor: 0.65,
    output: 'coffee_leaf_tea',
    mrv_pathway: 'Tea product traceability'
  },
  coffee_stems: {
    label: 'Coffee stems',
    vi_label: 'Thân cà phê',
    season: 'forest_products',
    carbon_factor: 3.0,
    yield_factor: 0.34,
    output: 'biochar',
    mrv_pathway: 'VM0044 biochar'
  },
  coffee_bark: {
    label: 'Coffee bark',
    vi_label: 'Vỏ cà phê',
    season: 'forest_products',
    carbon_factor: 3.0,
    yield_factor: 0.32,
    output: 'biochar',
    mrv_pathway: 'VM0044 biochar'
  },
  coffee_husk: {
    label: 'Coffee husk',
    vi_label: 'Vỏ quả cà phê',
    season: 'forest_products',
    carbon_factor: 3.0,
    yield_factor: 0.32,
    output: 'biochar',
    mrv_pathway: 'VM0044 biochar'
  },
  cajeput_residue: {
    label: 'Cajeput residue',
    vi_label: 'Bã tràm',
    season: 'perennial_melaleuca',
    carbon_factor: 2.8,
    yield_factor: 0.30,
    output: 'biochar_or_extract',
    mrv_pathway: 'Biochar plus extract traceability'
  },
  mixed: {
    label: 'Mixed biomass',
    vi_label: 'Sinh khối hỗn hợp',
    season: 'mixed',
    carbon_factor: 0,
    yield_factor: 0,
    output: 'mixed',
    mrv_pathway: 'Requires batch classification'
  }
};

const BIOMASS_ALIASES = {
  shrimp_sludge: 'pond_sludge',
  melaleuca: 'melaleuca_residue',
  tram: 'melaleuca_residue',
  coconut: 'coconut_husk',
  coconut_shell: 'coconut_husk',
  coconut_water: 'coconut_water_residue',
  coffee: 'coffee_husk',
  coffee_leaf: 'coffee_leaves',
  coffee_stem: 'coffee_stems',
  cajeput: 'cajeput_residue'
};

function normalizeBiomassType(type) {
  const key = String(type || '').trim();
  return BIOMASS_ALIASES[key] || key;
}

function getBiomassType(type) { return BIOMASS_TYPES[normalizeBiomassType(type)] || null; }
function isBiomassType(type) { return Boolean(getBiomassType(type)); }
function biomassCatalog() {
  return Object.entries(BIOMASS_TYPES).map(([id, value]) => ({ id, ...value }));
}

module.exports = { BIOMASS_TYPES, getBiomassType, isBiomassType, normalizeBiomassType, biomassCatalog };
