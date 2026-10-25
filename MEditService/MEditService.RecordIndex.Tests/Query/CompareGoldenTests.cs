using MEditService.LoadOrder;
using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda.Plugins;

namespace MEditService.RecordIndex.Tests.Query;

public sealed class CompareGoldenTests(CompareGoldenFixture fixture) : IClassFixture<CompareGoldenFixture>
{
    private OpenedIndex Index => fixture.Index;

    private CompareResult Compare(FormKey formKey) => Index.Queries.GetCompare(formKey.ToString()).Value().Require();

    private static object PluginWithoutItsPerRunTempPath(PluginResponse p) => new
    {
        p.Name,
        p.LoadOrderIndex,
        p.IsLight,
        p.IsMaster,
        p.Masters,
        p.IsImmutable,
        p.Origin,
        p.MissingMasters,
        p.InLoadOrder,
        p.HasMatchingRecords,
    };

    private static object Project(CompareResult compare) => new
    {
        compare.ConflictAll,
        Overrides = compare.Overrides.Select(o => new
        {
            o.FormKey,
            o.Plugin,
            o.Origin,
            o.LoadIndex,
            o.IsWinner,
            o.EditorId,
            o.RecordType,
            o.ConflictThis,
            o.IsPartialForm,
            Fields = o.Fields.ToDictionary(f => f.Metadata.Name, f => f.Value),
        }).ToList(),
        Diffs = compare.Diffs.Where(DiffersSomewhere).ToList(),
        DiffFieldCount = compare.Diffs.Count,
    };

    private static bool DiffersSomewhere(FieldDiff diff) =>
        diff.CellStates.Values.Any(state => state is not (ConflictThis.OnlyOne or ConflictThis.IdenticalToMaster or ConflictThis.Master));

    [Fact]
    public void Compare_AcrossThreePlugins_MatchesGolden()
    {
        var captured = new Dictionary<string, object?>
        {
            ["conflicted-npc"] = Project(Compare(CompareGoldenFixture.ConflictedNpc)),
            ["unchanged-weapon"] = Project(Compare(CompareGoldenFixture.UnchangedWeapon)),
            ["sole-npc"] = Project(Compare(CompareGoldenFixture.SoleNpc)),
            ["injected-npc"] = Project(Compare(CompareGoldenFixture.InjectedNpc)),
            ["conflicted-conditions"] = Project(Compare(CompareGoldenFixture.ConflictedRecipe)),
        };

        Golden.Verify("compare-three-plugins", captured);
    }

    [Fact]
    public void WinnerAndListings_MatchGolden()
    {
        var perPluginTypes = new[] { "Base.esm", "Mid.esp", "Top.esp" }.ToDictionary(
            name => name,
            name => Index.Queries.GetPluginRecordTypes(new PluginAddress(name, PluginOrigin.DataDirectory)).Value());

        var winningRecords = new[]
        {
            CompareGoldenFixture.ConflictedNpc, CompareGoldenFixture.UnchangedWeapon, CompareGoldenFixture.SoleNpc,
            CompareGoldenFixture.InjectedNpc, CompareGoldenFixture.ConflictedRecipe,
        }.ToDictionary(
            fk => fk.ToString(),
            fk =>
            {
                var d = Index.Queries.GetRecord(fk.ToString()).Value().Require();
                return new { d.Plugin, d.Origin, d.IsWinner, d.EditorId, d.RecordType };
            });

        var captured = new
        {
            Plugins = Index.Queries.GetPlugins().Value().Select(PluginWithoutItsPerRunTempPath).ToList(),
            PerPluginTypes = perPluginTypes,
            WinningRecords = winningRecords,
            AllNpcs = Index.Queries.GetRecords(["npc_"], plugin: null, search: null, limit: 50, offset: 0).Value().Items
                .OrderBy(r => r.FormKey, StringComparer.Ordinal).ThenBy(r => r.Plugin, StringComparer.Ordinal).ToList(),
            References = Index.Queries.GetReferences(new FormKey(ModKey.FromFileName("Base.esm"), 0x900).ToString()).Value()
                .OrderBy(r => r.FormKey, StringComparer.Ordinal).ToList(),
        };

        Golden.Verify("compare-load-order-listings", captured);
    }
}
