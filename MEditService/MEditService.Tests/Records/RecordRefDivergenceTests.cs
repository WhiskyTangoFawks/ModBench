using System.Text;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Records;

/// <summary>
/// <see cref="IRecordIndex.At"/>(<see cref="RecordRef.Head"/>) is a genuinely different
/// relation, not the same instance — so identical answers on unchanged records are a property to
/// prove, not a given.
///
/// <para>The first two cases use records with <b>no</b> working-tree change, where the two relations
/// hold the same row by construction and identical answers are still the correct ones — a broken
/// <c>At(Head)</c> that dropped the active filter or recomputed winner status differently fails here
/// exactly as it would have before. The divergence itself is <see cref="WorkingTreeChangeTests"/>'s
/// subject; the last case here pins only that it stays scoped to the record actually edited.</para>
/// </summary>
public sealed class RecordRefDivergenceTests : IDisposable
{
    private static readonly SchemaReflector Reflector = SharedSchemaReflector.Instance;
    private static readonly TableDdlBuilder Ddl = new TableDdlBuilder(Reflector);

    private readonly PluginFixtureData _fixture;
    private readonly FormKey _keptNpcFormKey;
    private readonly FormKey _droppedNpcFormKey;

    public RecordRefDivergenceTests()
    {
        FormKey keptFk = default, droppedFk = default;
        _fixture = new PluginFixtureBuilder("recordref-identity")
            .WithPlugin("Base.esm", mod =>
            {
                keptFk = mod.Npcs.AddNew("KeepMe").FormKey;
                droppedFk = mod.Npcs.AddNew("DropMe").FormKey;
            })
            .WithPlugin("Winner.esp", (mod, built) =>
            {
                mod.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName("Base.esm") });
                // Only "KeepMe" is overridden — "DropMe" stays sole-sourced from Base.esm, so its
                // one override is its own winner (a distinct case from KeepMe's non-winning base
                // entry, catching a would-be At(Head) that miscomputes IsWinner).
                var basePlugin = built.Single(m => m.ModKey.FileName == "Base.esm");
                mod.Npcs.Set(basePlugin.Npcs.First(n => n.FormKey == keptFk).DeepCopy());
            })
            .Build();
        _keptNpcFormKey = keptFk;
        _droppedNpcFormKey = droppedFk;
    }

    public void Dispose() => _fixture.Dispose();

    private static readonly PluginKey BaseKey = new("Base.esm", "Data");
    private static readonly PluginKey WinnerKey = new("Winner.esp", "Data");

    private DuckDbRecordIndex LoadedRepository()
    {
        var repo = new DuckDbRecordIndex(Reflector, Ddl, NullLogger.Instance);
        repo.Initialize(GameRelease.Fallout4);
        var basePath = new ModPath(ModKey.FromFileName("Base.esm"), Path.Combine(_fixture.DataFolder, "Base.esm"));
        var winnerPath = new ModPath(ModKey.FromFileName("Winner.esp"), Path.Combine(_fixture.DataFolder, "Winner.esp"));
        var baseMod = Fallout4Mod.CreateFromBinaryOverlay(basePath, Fallout4Release.Fallout4);
        var winnerMod = Fallout4Mod.CreateFromBinaryOverlay(winnerPath, Fallout4Release.Fallout4);
        repo.Index(baseMod, Registration.Participating(0), new PluginKey(baseMod.ModKey.FileName.ToString(), "Data"));
        repo.Index(winnerMod, Registration.Participating(1), new PluginKey(winnerMod.ModKey.FileName.ToString(), "Data"));
        repo.UpdateWinners();
        return repo;
    }

    // The same "KeepMe" override deleted in the working tree, reused by every one of the five
    // extracted/aggregate reads below — one crafted divergence, five distinct At(Head) observers, the
    // same shape RecordRefDivergenceTests already uses for GetOverrideStack/Search above. Deletion is
    // structural, so ApplyWorkingTreeChanges' own UpdateWinners() resweep already covers it — no
    // second call needed here.
    private DuckDbRecordIndex RepositoryWithWinnerOverrideDeleted()
    {
        var repo = LoadedRepository();
        repo.ApplyWorkingTreeChanges(WinnerKey, [(_keptNpcFormKey.ToString(), null)]);
        return repo;
    }

    // A real codec-produced body, the same shape CreateRecord writes in production (mirrors
    // WorkingTreeCreationTests' own helper) — a hand-crafted JSON literal would only prove this test's
    // guess at the codec's shape, not that a genuinely new record round-trips.
    private static readonly RecordTextCodec Codec = new(NullLogger<RecordTextCodec>.Instance);

    private static string NewNpcBody(string formKey, string editorId)
    {
        var npc = new Npc(FormKey.Factory(formKey), Fallout4Release.Fallout4) { EditorID = editorId };
        var bytes = Codec.SerializeToBytesAsync(npc, GameRelease.Fallout4).GetAwaiter().GetResult();
        return Encoding.UTF8.GetString(bytes);
    }

    [Fact]
    public void AtHead_Search_MatchesEffective_WithAnActiveFilterNarrowingTheListing()
    {
        using var repo = LoadedRepository();
        // Narrows the listing to just "KeepMe"'s two override rows (Base.esm + Winner.esp) out of
        // the fixture's three (DropMe's lone Base.esm row is excluded) — a broken At(Head) that
        // dropped the active filter (SetFilter is seam-wide state, easy to forget wiring into a
        // second entry point) would return all three instead, diverging from Effective here.
        repo.SetFilter($"SELECT '{_keptNpcFormKey}' AS form_key");

        var query = new RecordQuery(RecordTypes: ["npc_"], Limit: 10, Offset: 0);
        var effective = repo.Search(query);
        var head = repo.At(RecordRef.Head).Search(query);

        Assert.Equal(2, effective.Total);
        Assert.All(effective.Items, i => Assert.Equal(_keptNpcFormKey.ToString(), i.FormKey));
        Assert.Equal(effective.Total, head.Total);
        Assert.Equal(
            effective.Items.Select(i => (i.FormKey, i.Plugin)),
            head.Items.Select(i => (i.FormKey, i.Plugin)));
    }

    [Fact]
    public void AtHead_GetOverrideStack_MatchesEffective_IncludingTheNonWinningEntry()
    {
        using var repo = LoadedRepository();

        // KeepMe has two overrides (Base.esm loses, Winner.esp wins) — a broken At(Head) that
        // recomputed winner status differently (e.g. always true, or by load-order alone ignoring
        // participation) would diverge on IsWinner here without changing the entry count.
        var effectiveStack = repo.GetOverrideStack(_keptNpcFormKey.ToString());
        var headStack = repo.At(RecordRef.Head).GetOverrideStack(_keptNpcFormKey.ToString());

        Assert.Equal(2, effectiveStack!.Entries.Count);
        Assert.Equal(
            effectiveStack.Entries.Select(e => (e.Plugin, e.IsWinner)),
            headStack!.Entries.Select(e => (e.Plugin, e.IsWinner)));

        // DropMe's sole override is its own winner — the distinct case from KeepMe's losing base
        // entry above, exercised at both refs too.
        var effectiveDropped = repo.GetDocument(_droppedNpcFormKey.ToString());
        var headDropped = repo.At(RecordRef.Head).GetDocument(_droppedNpcFormKey.ToString());
        Assert.True(effectiveDropped!.IsWinner);
        Assert.Equal(effectiveDropped.IsWinner, headDropped!.IsWinner);
        Assert.Equal(effectiveDropped.Plugin, headDropped.Plugin);
    }

    [Fact]
    public void AWorkingTreeChange_DivergesOnlyTheEditedRecord_LeavingEveryOtherRefAnswerAlone()
    {
        using var repo = LoadedRepository();
        var edited = _keptNpcFormKey.ToString();
        var untouched = _droppedNpcFormKey.ToString();
        var basePlugin = new PluginKey("Base.esm", "Data");

        var before = repo.GetDocument(edited, basePlugin)!;
        repo.ApplyWorkingTreeChanges(
            basePlugin, [(edited, before.Body!.Replace("KeepMe", "RenamedInWorkingTree", StringComparison.Ordinal))]);

        // The edited record's own Base.esm entry diverges...
        var stack = repo.GetOverrideStack(edited)!;
        var baseEntry = stack.Entries.Single(e => e.Plugin.Name == "Base.esm");
        Assert.True(baseEntry.HasWorkingTreeChange);
        Assert.NotEqual(baseEntry.Effective.Body, baseEntry.Head.Body);

        // ...while Winner.esp's entry for that same FormKey, which nothing edited, does not.
        var winnerEntry = stack.Entries.Single(e => e.Plugin.Name == "Winner.esp");
        Assert.False(winnerEntry.HasWorkingTreeChange);
        Assert.Equal(winnerEntry.Effective.Body, winnerEntry.Head.Body);

        // ...and neither does an entirely different record in the same plugin.
        Assert.Equal(
            repo.GetDocument(untouched, basePlugin)!.Body,
            repo.At(RecordRef.Head).GetDocument(untouched, basePlugin)!.Body);
    }

    // Only these tests exercise the At(RecordRef.Head) path of the 7 relation-parameterized twins
    // (GetRecordTypeCounts, GetPluginsWithMatchingRecords, GetNativeFormKeys,
    // GetEffectiveMasters, GetWorldspaceCells, GetInteriorCells, GetCellReferences) — everything
    // else in the suite exercises them at Effective only. Four are covered below and three
    // cell/placement-table ones in RecordRefDivergenceCellReadsTests, so a relation plumbed wrong
    // has something to fail against instead of passing by construction.

    [Fact]
    public void AtHead_GetPluginsWithMatchingRecords_StillNamesThePluginWithAnEffectivelyDeletedOverride()
    {
        using var repo = RepositoryWithWinnerOverrideDeleted();
        repo.SetFilter($"SELECT '{_keptNpcFormKey}' AS form_key");

        var effective = repo.GetPluginsWithMatchingRecords(["npc_"]);
        var head = repo.At(RecordRef.Head).GetPluginsWithMatchingRecords(["npc_"]);

        Assert.DoesNotContain("Winner.esp", effective);
        Assert.Contains("Winner.esp", head);
        // Base.esm's own row was never touched, so it matches at both — proving the difference above
        // is Winner.esp's row specifically, not the filter or the plugin set collapsing wholesale.
        Assert.Contains("Base.esm", effective);
        Assert.Contains("Base.esm", head);
    }

    [Fact]
    public void AtHead_GetEffectiveMasters_StillRequiresTheEffectivelyDeletedOverridesMaster()
    {
        using var repo = RepositoryWithWinnerOverrideDeleted();

        // Winner.esp's only record was its now-deleted override of KeepMe, so nothing in its
        // Effective rows still forces Base.esm as a master. Head's committed row still does.
        Assert.DoesNotContain("Base.esm", repo.GetEffectiveMasters(WinnerKey));
        Assert.Contains("Base.esm", repo.At(RecordRef.Head).GetEffectiveMasters(WinnerKey));
    }

    [Fact]
    public void AtHead_GetRecordTypeCounts_ExcludesAWorkingTreeOnlyCreatedRecord()
    {
        using var repo = LoadedRepository();
        var newFormKey = "800000:Base.esm";
        repo.CreateWorkingTreeRecord(BaseKey, newFormKey, "npc_", NewNpcBody(newFormKey, "WorkingTreeOnlyNpc"));

        var effectiveCount = repo.GetRecordTypeCounts(BaseKey).Single(c => c.Type == "npc_").Count;
        var headCount = repo.At(RecordRef.Head).GetRecordTypeCounts(BaseKey).Single(c => c.Type == "npc_").Count;

        Assert.Equal(headCount + 1, effectiveCount);
    }

    [Fact]
    public void AtHead_GetNativeFormKeys_ExcludesAWorkingTreeOnlyCreatedRecord()
    {
        using var repo = LoadedRepository();
        var newFormKey = "800000:Base.esm";
        repo.CreateWorkingTreeRecord(BaseKey, newFormKey, "npc_", NewNpcBody(newFormKey, "WorkingTreeOnlyNpc"));

        Assert.Contains(newFormKey, repo.GetNativeFormKeys(BaseKey));
        Assert.DoesNotContain(newFormKey, repo.At(RecordRef.Head).GetNativeFormKeys(BaseKey));
    }
}
