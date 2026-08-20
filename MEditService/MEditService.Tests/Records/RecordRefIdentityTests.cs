using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Records;

/// <summary>
/// AC4: <see cref="IRecordIndex.At"/>(<see cref="RecordRef.Head"/>) answers identically to the
/// default <see cref="RecordRef.Effective"/> surface. #421 ships them mapping onto the same
/// <c>records.ref</c> constant (<c>LedgerRef.Committed</c> — ADR-0041), so this is a real regression
/// guard even though today's <c>At</c> is <c>=&gt; this</c>: the fixture below is built so a broken
/// <c>At(Head)</c> that dropped the active filter, or that recomputed winner status differently,
/// would fail this test — see the rival recorded on #421's landing report.
/// </summary>
public sealed class RecordRefIdentityTests : IDisposable
{
    private static readonly ISchemaReflector Reflector = SharedSchemaReflector.Instance;
    private static readonly ITableDdlBuilder Ddl = new TableDdlBuilder(Reflector);

    private readonly PluginFixtureData _fixture;
    private readonly FormKey _keptNpcFormKey;
    private readonly FormKey _droppedNpcFormKey;

    public RecordRefIdentityTests()
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

    private DuckDbRecordIndex LoadedRepository()
    {
        var repo = new DuckDbRecordIndex(Reflector, Ddl, NullLogger.Instance);
        repo.Initialize(GameRelease.Fallout4);
        var basePath = new ModPath(ModKey.FromFileName("Base.esm"), Path.Combine(_fixture.DataFolder, "Base.esm"));
        var winnerPath = new ModPath(ModKey.FromFileName("Winner.esp"), Path.Combine(_fixture.DataFolder, "Winner.esp"));
        repo.Index(Fallout4Mod.CreateFromBinaryOverlay(basePath, Fallout4Release.Fallout4), 0, participates: true, origin: "Data");
        repo.Index(Fallout4Mod.CreateFromBinaryOverlay(winnerPath, Fallout4Release.Fallout4), 1, participates: true, origin: "Data");
        repo.UpdateWinners();
        return repo;
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
}
