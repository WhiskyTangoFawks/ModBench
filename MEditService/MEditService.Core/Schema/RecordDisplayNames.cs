namespace MEditService.Core.Schema;

// xEdit shows a human-readable name per record type (the second argument of each
// `wbRecord(<SIG>, '<Display Name>', ...)` / `wbRefRecord(<SIG>, '<Display Name>', ...)` call in
// references/TES5Edit/Core/wbDefinitionsFO4.pas). This table is a one-time hand-transcription of
// that reference (grep-only, never modified) — not a runtime parser, since the mapping is static
// and the reference isn't shipped.
// "npc_" and "header" aren't `wbRecord` matches by signature text (NPC_ / TES4) so are called out
// separately below. Every table SchemaReflector currently discovers has an entry here (see
// SchemaReflectorTests.GetSchemas_EveryDiscoveredTableHasADisplayName); a lookup miss falls back to
// the raw signature rather than throwing, so a newly-discovered Mutagen type never breaks startup.
internal static class RecordDisplayNames
{
    private static readonly Dictionary<string, string> Names = new(StringComparer.OrdinalIgnoreCase)
    {
        ["npc_"] = "Non-Player Character",
        ["header"] = "Main File Header",

        ["aact"] = "Action",
        ["achr"] = "Placed NPC",
        ["acti"] = "Activator",
        ["addn"] = "Addon Node",
        ["aech"] = "Audio Effect Chain",
        ["alch"] = "Ingestible",
        ["amdl"] = "Aim Model",
        ["ammo"] = "Ammunition",
        ["anio"] = "Animated Object",
        ["aoru"] = "Attraction Rule",
        ["arma"] = "Armor Addon",
        ["armo"] = "Armor",
        ["arto"] = "Art Object",
        ["aspc"] = "Acoustic Space",
        ["astp"] = "Association Type",
        ["avif"] = "Actor Value Information",
        ["bnds"] = "Bendable Spline",
        ["book"] = "Book",
        ["bptd"] = "Body Part Data",
        ["cams"] = "Camera Shot",
        ["cell"] = "Cell",
        ["clas"] = "Class",
        ["clfm"] = "Color",
        ["clmt"] = "Climate",
        ["cmpo"] = "Component",
        ["cobj"] = "Constructible Object",
        ["coll"] = "Collision Layer",
        ["cont"] = "Container",
        ["cpth"] = "Camera Path",
        ["csty"] = "Combat Style",
        ["debr"] = "Debris",
        ["dfob"] = "Default Object",
        ["dial"] = "Dialog Topic",
        ["dlbr"] = "Dialog Branch",
        ["dlvw"] = "Dialog View",
        ["dmgt"] = "Damage Type",
        ["dobj"] = "Default Object Manager",
        ["door"] = "Door",
        ["dual"] = "Dual Cast Data",
        ["eczn"] = "Encounter Zone",
        ["efsh"] = "Effect Shader",
        ["ench"] = "Enchantment",
        ["equp"] = "Equip Type",
        ["expl"] = "Explosion",
        ["fact"] = "Faction",
        ["flor"] = "Flora",
        ["flst"] = "FormID List",
        ["fstp"] = "Footstep",
        ["fsts"] = "Footstep Set",
        ["furn"] = "Furniture",
        ["gdry"] = "God Rays",
        ["glob"] = "Global",
        ["gmst"] = "Game Setting",
        ["gras"] = "Grass",
        ["hazd"] = "Hazard",
        ["hdpt"] = "Head Part",
        ["idle"] = "Idle Animation",
        ["idlm"] = "Idle Marker",
        ["imad"] = "Image Space Adapter",
        ["imgs"] = "Image Space",
        ["info"] = "Dialog response",
        ["ingr"] = "Ingredient",
        ["innr"] = "Instance Naming Rules",
        ["ipct"] = "Impact",
        ["ipds"] = "Impact Data Set",
        ["keym"] = "Key",
        ["kssm"] = "Sound Keyword Mapping",
        ["kywd"] = "Keyword",
        ["layr"] = "Layer",
        ["lcrt"] = "Location Reference Type",
        ["lctn"] = "Location",
        ["lens"] = "Lens Flare",
        ["lgtm"] = "Lighting Template",
        ["ligh"] = "Light",
        ["lscr"] = "Load Screen",
        ["ltex"] = "Landscape Texture",
        ["lvli"] = "Leveled Item",
        ["lvln"] = "Leveled NPC",
        ["mato"] = "Material Object",
        ["matt"] = "Material Type",
        ["mesg"] = "Message",
        ["mgef"] = "Magic Effect",
        ["misc"] = "Misc. Item",
        ["movt"] = "Movement Type",
        ["mstt"] = "Moveable Static",
        ["mswp"] = "Material Swap",
        ["musc"] = "Music Type",
        ["must"] = "Music Track",
        ["nocm"] = "Navmesh Obstacle Manager",
        ["note"] = "Note",
        ["omod"] = "Object Modification",
        ["otft"] = "Outfit",
        ["ovis"] = "Object Visibility Manager",
        ["pack"] = "Package",
        ["perk"] = "Perk",
        ["pkin"] = "Pack-In",
        ["proj"] = "Projectile",
        ["qust"] = "Quest",
        ["race"] = "Race",
        ["refr"] = "Placed Object",
        ["regn"] = "Region",
        ["rela"] = "Relationship",
        ["revb"] = "Reverb Parameters",
        ["rfct"] = "Visual Effect",
        ["rfgp"] = "Reference Group",
        ["scco"] = "Scene Collection",
        ["scen"] = "Scene",
        ["scol"] = "Static Collection",
        ["scsn"] = "Audio Category Snapshot",
        ["smbn"] = "Story Manager Branch Node",
        ["smen"] = "Story Manager Event Node",
        ["smqn"] = "Story Manager Quest Node",
        ["snct"] = "Sound Category",
        ["sndr"] = "Sound Descriptor",
        ["sopm"] = "Sound Output Model",
        ["soun"] = "Sound Marker",
        ["spel"] = "Spell",
        ["spgd"] = "Shader Particle Geometry",
        ["stag"] = "Animation Sound Tag Set",
        ["stat"] = "Static",
        ["tact"] = "Talking Activator",
        ["term"] = "Terminal",
        ["tree"] = "Tree",
        ["trns"] = "Transform",
        ["txst"] = "Texture Set",
        ["vtyp"] = "Voice Type",
        ["watr"] = "Water",
        ["weap"] = "Weapon",
        ["wrld"] = "Worldspace",
        ["wthr"] = "Weather",
        ["zoom"] = "Zoom",
    };

    internal static string For(string tableName) =>
        Names.TryGetValue(tableName, out var name) ? name : tableName;
}

public static class RecordTableSchemaLookupExtensions
{
    /// <summary>
    /// The xEdit-parity display name for <paramref name="tableName"/>, read off the reflected
    /// schema when known. Falls back to <paramref name="tableName"/> itself (the raw signature)
    /// when the type isn't a known schema — e.g. a record whose RecordType predates a schema
    /// change. Single home for this fallback rule (RecordQueryService).
    /// </summary>
    public static string DisplayNameFor(
        this IReadOnlyDictionary<string, RecordTableSchema> schemas, string tableName) =>
        schemas.TryGetValue(tableName, out var schema) ? schema.DisplayName : tableName;
}
