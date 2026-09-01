using DuckDB.NET.Data;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Records;

/// <summary>
/// ADR-0001: winning is a function of the registered load order, so it lives in a
/// load order-owned derived table — <c>winners</c>, one row per (ref, FormKey) naming the plugin
/// whose copy wins — and never as a column on a data row. These tests read that table directly,
/// because "where the answer is stored" is the whole point here: the behavioural half
/// (a promotion after a delete, a reorder flipping the stack) is already pinned by
/// <see cref="WorkingTreeDeletionTests"/>, <see cref="LoadOrderViaRegistrationTests"/> and
/// <see cref="RegistrationScopingTests"/>, and those keep passing through the new shape.
/// </summary>
public sealed class WinnersDerivedTableTests : IDisposable
{
    private static readonly SchemaReflector Reflector = SharedSchemaReflector.Instance;
    private static readonly TableDdlBuilder Ddl = new TableDdlBuilder(Reflector);

    private static readonly PluginKey BaseKey = new("Base.esm", "Data");
    private static readonly PluginKey OverKey = new("Over.esp", "Data");

    private readonly PluginFixtureData _fixture;
    private readonly string _npc;

    public WinnersDerivedTableTests()
    {
        FormKey npc = default;
        _fixture = new PluginFixtureBuilder("winners-derived-table")
            .WithPlugin("Base.esm", mod => npc = mod.Npcs.AddNew("TestNpc").FormKey)
            .WithPlugin("Over.esp", (mod, built) =>
            {
                mod.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName("Base.esm") });
                var basePlugin = built.Single(m => m.ModKey.FileName == "Base.esm");
                mod.Npcs.Set(basePlugin.Npcs.First(n => n.FormKey == npc).DeepCopy());
            })
            .Build();
        _npc = npc.ToString();
    }

    public void Dispose() => _fixture.Dispose();

    private DuckDbRecordIndex LoadedIndex()
    {
        var index = new DuckDbRecordIndex(Reflector, Ddl, NullLogger.Instance);
        index.Initialize(GameRelease.Fallout4);
        Open(index, "Base.esm", 0);
        Open(index, "Over.esp", 1);
        index.UpdateWinners();
        return index;
    }

    private void Open(DuckDbRecordIndex index, string name, int loadOrderIndex)
    {
        var path = new ModPath(ModKey.FromFileName(name), Path.Combine(_fixture.DataFolder, name));
        index.Index(
            Fallout4Mod.CreateFromBinaryOverlay(path, Fallout4Release.Fallout4), Registration.Participating(loadOrderIndex), new PluginKey(name, "Data"));
    }

    /// <summary>The (plugin, origin) named as winning <paramref name="formKey"/> at
    /// <paramref name="recordRef"/>, or null when nothing wins it there.</summary>
    private static (string Plugin, string Origin)? WinnerOf(DuckDbRecordIndex index, RecordRef recordRef, string formKey)
    {
        using var cmd = index.Connection.CreateCommand();
        cmd.CommandText = "SELECT plugin, origin FROM winners WHERE record_ref = $1 AND form_key = $2";
        cmd.Parameters.Add(new DuckDBParameter { Value = WinnerRef.Of(recordRef) });
        cmd.Parameters.Add(new DuckDBParameter { Value = formKey });
        using var reader = cmd.ExecuteReader();
        return reader.Read() ? (reader.GetString(0), reader.GetString(1)) : null;
    }

    private static (string Plugin, string Origin)? Expected(PluginKey key) => (key.Name, key.Origin!);

    private static long Scalar(DuckDbRecordIndex index, string sql)
    {
        using var cmd = index.Connection.CreateCommand();
        cmd.CommandText = sql;
        return Convert.ToInt64(cmd.ExecuteScalar(), System.Globalization.CultureInfo.InvariantCulture);
    }

    [Fact]
    public void TheSweep_NamesTheLatestParticipatingPlugin_OncePerFormKeyPerRef()
    {
        using var index = LoadedIndex();

        Assert.Equal(Expected(OverKey), WinnerOf(index, RecordRef.Effective, _npc));
        Assert.Equal(Expected(OverKey), WinnerOf(index, RecordRef.Head, _npc));

        // The table is a function, not a set of flags: (record_ref, form_key) is its key, so a
        // reader can LEFT JOIN it without risking a duplicated record row. Two plugins share this
        // FormKey and exactly one row per ref names a winner for it.
        Assert.Equal(2, Scalar(index, $"SELECT COUNT(*) FROM winners WHERE form_key = '{_npc}'"));

        // Every plugin header wins its own FormKey. It is swept by construction rather than by a
        // branch of its own since #631 — it is an ordinary `records` row, and the sweep reads that
        // one relation. Still asserted, because "no winner" reads as "no header exists" through Open
        // Header's winner-only lookup, and that is a real failure mode however the row gets there.
        foreach (var plugin in new[] { BaseKey, OverKey })
        {
            var headerFk = HeaderIndexer.FormKeyFor(ModKey.FromFileName(plugin.Name));
            Assert.Equal(Expected(plugin), WinnerOf(index, RecordRef.Effective, headerFk));
        }

        // Re-running the sweep is idempotent — it rebuilds the table wholesale rather than adding to it.
        var before = Scalar(index, "SELECT COUNT(*) FROM winners");
        index.UpdateWinners();
        Assert.Equal(before, Scalar(index, "SELECT COUNT(*) FROM winners"));
    }

    [Fact]
    public void ADisabledPlugin_WinsNothing_AndWinsAgainOnceReEnabledAndSwept()
    {
        using var index = LoadedIndex();

        index.Register(OverKey, Registration.Disabled(1));
        index.UpdateWinners();

        // Disabled in plugins.txt: Over.esp is registered (so its rows are still visible) but out of
        // the stack, so the plugin below it holds the field at both refs.
        Assert.Equal(Expected(BaseKey), WinnerOf(index, RecordRef.Effective, _npc));
        Assert.Equal(Expected(BaseKey), WinnerOf(index, RecordRef.Head, _npc));
        Assert.Equal(0, Scalar(index, $"SELECT COUNT(*) FROM winners WHERE plugin = '{OverKey.Name}'"));
        Assert.Equal(BaseKey.Name, index.GetDocument(_npc)!.Plugin.Name);

        index.Register(OverKey, Registration.Participating(1));
        index.UpdateWinners();

        Assert.Equal(Expected(OverKey), WinnerOf(index, RecordRef.Effective, _npc));
        Assert.Equal(OverKey.Name, index.GetDocument(_npc)!.Plugin.Name);
    }

    [Fact]
    public void AnUnregisteredPlugin_WinsNothing_EvenThoughItsRowsAreStillThere()
    {
        using var index = LoadedIndex();

        index.Unregister(OverKey);
        index.UpdateWinners();

        Assert.True(Scalar(index, $"SELECT COUNT(*) FROM mirror.records WHERE plugin = '{OverKey.Name}'") > 0,
            "Premise: unregistering leaves the mirror rows in place (#582).");
        Assert.Equal(0, Scalar(index, $"SELECT COUNT(*) FROM winners WHERE plugin = '{OverKey.Name}'"));
        Assert.Equal(Expected(BaseKey), WinnerOf(index, RecordRef.Effective, _npc));
    }

    /// <summary>
    /// Head's winners are swept, not derived per read, so every writer that moves a row into or out
    /// of the Head relation has to resweep. <c>SeedCommittedOnly</c> is the "adds one" case: a
    /// record HEAD holds and the working tree deleted exists at Head and nowhere else, and without
    /// the resweep it would have no winner at all — which reads as "the record does not exist" through
    /// every winner-only lookup at that ref.
    /// </summary>
    [Fact]
    public void SeedCommittedOnly_GivesTheRecordItAddsAtHead_AWinnerThere()
    {
        using var index = LoadedIndex();
        var baseBody = index.GetDocument(_npc, BaseKey)!.Body!;

        // Both plugins' copies vanish from the working tree and turn out to be held by no commit
        // either, so nothing holds the NPC at either ref...
        index.ApplyWorkingTreeChanges(OverKey, [(_npc, null)]);
        index.ApplyWorkingTreeChanges(BaseKey, [(_npc, null)]);
        index.MarkWorkingTreeOnly(OverKey, [_npc]);
        index.MarkWorkingTreeOnly(BaseKey, [_npc]);
        Assert.Null(WinnerOf(index, RecordRef.Effective, _npc));
        Assert.Null(index.At(RecordRef.Head).GetDocument(_npc));

        // ...and then a reconciliation pass finds Base.esm's copy in HEAD's tree after all. It is
        // deliberately not the plugin that was winning before: a stale winners table still naming
        // Over.esp would leave the row this call adds losing to a plugin that holds nothing at Head.
        index.SeedCommittedOnly(BaseKey, [(_npc, "npc_", baseBody)]);

        Assert.Equal(Expected(BaseKey), WinnerOf(index, RecordRef.Head, _npc));
        Assert.Equal(BaseKey.Name, index.At(RecordRef.Head).GetDocument(_npc)!.Plugin.Name);
        Assert.Null(WinnerOf(index, RecordRef.Effective, _npc));
    }

    /// <summary>
    /// The mirror: <c>MarkWorkingTreeOnly</c> is the "removes one" case. Taking the winning plugin's
    /// copy out of Head has to promote the next plugin down <i>at that ref</i>, exactly as a
    /// working-tree deletion promotes at Effective.
    /// </summary>
    [Fact]
    public void MarkWorkingTreeOnly_PromotesTheNextPluginDown_AtHead()
    {
        using var index = LoadedIndex();
        Assert.Equal(Expected(OverKey), WinnerOf(index, RecordRef.Head, _npc));

        // Over.esp's copy turns out to be a working-tree create that no commit holds.
        index.MarkWorkingTreeOnly(OverKey, [_npc]);

        Assert.Equal(Expected(BaseKey), WinnerOf(index, RecordRef.Head, _npc));
        Assert.Equal(BaseKey.Name, index.At(RecordRef.Head).GetDocument(_npc)!.Plugin.Name);

        // Effective never changed: Over.esp still holds the field the editor shows.
        Assert.Equal(Expected(OverKey), WinnerOf(index, RecordRef.Effective, _npc));
        Assert.Equal(OverKey.Name, index.GetDocument(_npc)!.Plugin.Name);
    }
}
