using MEditService.Codec.Schema;
using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.Queries;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Query;

/// <summary>Pins what the classifier makes of several plugins disagreeing, including the two easy
/// to get wrong: an override identical to its master (not a conflict) and one out-competed by a
/// later override.</summary>
public sealed class CompareGoldenTests : IDisposable
{
    private readonly PluginFixtureData _fixture;
    private readonly IndexProjector _manager;
    private readonly RecordQueryService _service;
    // Kept so WinnerAndListings_MatchGolden can inline the record-type count against the reflector.
    private readonly SchemaReflector _reflector;

    private static readonly FormKey ConflictedNpc = MakeKey("Base.esm", 0x800);
    private static readonly FormKey UnchangedWeapon = MakeKey("Base.esm", 0x801);
    private static readonly FormKey SoleNpc = MakeKey("Base.esm", 0x802);
    private static readonly FormKey InjectedNpc = MakeKey("Mid.esp", 0x800);
    private static readonly FormKey ConflictedRecipe = MakeKey("Base.esm", 0x803);

    private static FormKey MakeKey(string plugin, uint id) => new(ModKey.FromFileName(plugin), id);

    public CompareGoldenTests()
    {
        var holder = new LoadOrderHolder();
        _fixture = new PluginFixtureBuilder("compare-golden")
            .WithPlugin("Base.esm", mod =>
            {
                var npc = mod.Npcs.AddNew("ConflictedNPC");
                npc.Name = "Base name";
                npc.CalculatedHealth = 100;
                npc.Race.SetTo(MakeKey("Base.esm", 0x900));

                var weapon = mod.Weapons.AddNew("UnchangedWeapon");
                weapon.Value = 25;
                weapon.Weight = 2.5f;

                var lonely = mod.Npcs.AddNew("SoleNPC");
                lonely.CalculatedHealth = 7;

                // A condition list is an ordinary reflected array column, so a record carrying one belongs in this
                // golden like any other conflicting field: the classifier producing its diff tree is the one
                // classifier, with no section of its own.
                var recipe = mod.ConstructibleObjects.AddNew("ConflictedRecipe");
                recipe.Conditions.Add(new ConditionFloat
                {
                    CompareOperator = CompareOperator.EqualTo,
                    ComparisonValue = 1f,
                    Flags = Condition.Flag.OR,
                    Data = new FunctionConditionData { Function = Condition.Function.GetIsID },
                });
            })
            .WithPlugin("Mid.esp", (mod, built) =>
            {
                var basePlugin = built.Single(m => m.ModKey.FileName == "Base.esm");
                mod.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName("Base.esm") });

                // A real override that changes two fields and leaves the rest alone.
                var npc = basePlugin.Npcs.First(n => n.FormKey == ConflictedNpc).DeepCopy();
                npc.Name = "Mid name";
                npc.CalculatedHealth = 250;
                mod.Npcs.Set(npc);

                // An override identical to its master — the ITM shape, which must classify as
                // no conflict rather than as a difference of zero size.
                mod.Weapons.Set(basePlugin.Weapons.First(w => w.FormKey == UnchangedWeapon).DeepCopy());

                // A record injected into a master's FormID space by a plugin that isn't its origin.
                mod.Npcs.AddNew("InjectedNPC").Name = "Injected";
            })
            .WithPlugin("Top.esp", (mod, built) =>
            {
                var basePlugin = built.Single(m => m.ModKey.FileName == "Base.esm");
                mod.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName("Base.esm") });

                // The winning override: disagrees with both of the copies below it.
                var npc = basePlugin.Npcs.First(n => n.FormKey == ConflictedNpc).DeepCopy();
                npc.Name = "Top name";
                npc.CalculatedHealth = 999;
                npc.Race.SetTo(MakeKey("Base.esm", 0x901));
                mod.Npcs.Set(npc);

                // The condition list disagrees with its master on one member of one condition —
                // the compare tree has to reach the member, not stop at the array.
                var recipe = basePlugin.ConstructibleObjects.First(c => c.FormKey == ConflictedRecipe).DeepCopy();
                recipe.Conditions[0].Data.RunOnType = Condition.RunOnType.Target;
                mod.ConstructibleObjects.Set(recipe);
            })
            .Build();

        var reflector = SharedSchemaReflector.Instance;
        _reflector = reflector;
        _manager = new IndexProjector(holder, MutagenPluginAdapter.Instance, new DuckDbRecordIndexFactory(reflector, new TableDdlBuilder(reflector)));
        _manager.Reconcile(holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4);
        _service = new RecordQueryService(_manager, holder, reflector, new ConflictClassifier());
    }

    public void Dispose()
    {
        _manager.Dispose();
        _fixture.Dispose();
    }

    private static object Project(CompareResult r) => new
    {
        r.ConflictAll,
        Overrides = r.Overrides.Select(o => new
        {
            o.FormKey,
            o.Plugin,
            o.Origin,
            o.LoadOrderIndex,
            o.IsWinner,
            o.EditorId,
            o.RecordType,
            o.ConflictThis,
            o.IsPartialForm,
            Fields = o.Fields.ToDictionary(f => f.Metadata.Name, f => f.Value),
        }).ToList(),
        // Only fields that actually differ somewhere: an aligned diff tree over every reflected
        // column of an NPC is ~200 entries of "everyone agrees", which would bury the four that
        // carry the answer.
        Diffs = r.Diffs.Where(d => d.CellStates.Values.Any(s => s is not (ConflictThis.OnlyOne or ConflictThis.IdenticalToMaster or ConflictThis.Master))).ToList(),
        DiffFieldCount = r.Diffs.Count,
    };

    [Fact]
    public void Compare_AcrossThreePlugins_MatchesGolden()
    {
        var conflictedNpc = _service.GetCompare(ConflictedNpc.ToString());
        var unchangedWeapon = _service.GetCompare(UnchangedWeapon.ToString());
        var soleNpc = _service.GetCompare(SoleNpc.ToString());
        var injectedNpc = _service.GetCompare(InjectedNpc.ToString());
        var conflictedRecipe = _service.GetCompare(ConflictedRecipe.ToString());
        Assert.NotNull(conflictedNpc);
        Assert.NotNull(unchangedWeapon);
        Assert.NotNull(soleNpc);
        Assert.NotNull(injectedNpc);
        Assert.NotNull(conflictedRecipe);

        var captured = new Dictionary<string, object?>
        {
            ["conflicted-npc"] = Project(conflictedNpc),
            ["unchanged-weapon"] = Project(unchangedWeapon),
            ["sole-npc"] = Project(soleNpc),
            ["injected-npc"] = Project(injectedNpc),
            ["conflicted-conditions"] = Project(conflictedRecipe),
        };

        Golden.Verify("compare-three-plugins", captured);
    }

    [Fact]
    public void WinnerAndListings_MatchGolden()
    {
        var captured = new
        {
            // Path is deliberately absent: it is a per-run temp directory.
            Plugins = _service.GetPlugins().Select(p => new
            {
                p.Copy.Name,
                LoadOrderIndex = p.Copy.Slot,
                p.Content.IsLight,
                p.Content.IsMaster,
                p.Content.Masters,
                p.Content.RecordCount,
                p.Copy.IsImmutable,
                p.Copy.Registration.Participates,
                p.Copy.Origin,
                p.MasterIssues,
                p.Copy.Registration.InLoadOrder,
                p.HasMatchingRecords,
            }).ToList(),
            // GameRelease.Fallout4 is hardcoded rather than derived from the reconciled load order: the same
            // constant this fixture reconciles with two lines above, and the game-generalization rule permits
            // an FO4-concrete test fixture.
            RecordTypes = _reflector.GetSchemas(GameRelease.Fallout4).Keys.Count(t => t != PluginHeader.RecordType),
            PerPluginTypes = new[] { "Base.esm", "Mid.esp", "Top.esp" }
                .ToDictionary(p => p, p => _service.GetPluginRecordTypes(p)),
            WinningRecords = new[] { ConflictedNpc, UnchangedWeapon, SoleNpc, InjectedNpc, ConflictedRecipe }
                .ToDictionary(fk => fk.ToString(), fk =>
                {
                    var d = _service.GetRecord(fk.ToString());
                    Assert.NotNull(d);
                    return new { d.Plugin, d.Origin, d.IsWinner, d.EditorId, d.RecordType, d.LoadOrderIndex };
                }),
            AllNpcs = _service.GetRecords("npc_", null, null, 50, 0)
                .Items.OrderBy(r => r.FormKey, StringComparer.Ordinal).ThenBy(r => r.Plugin, StringComparer.Ordinal).ToList(),
            References = _service.GetReferences(MakeKey("Base.esm", 0x900).ToString())
                .OrderBy(r => r.FormKey, StringComparer.Ordinal).ToList(),
        };

        Golden.Verify("compare-load-order-listings", captured);
    }
}
