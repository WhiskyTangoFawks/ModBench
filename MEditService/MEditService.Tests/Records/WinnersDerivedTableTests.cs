using DuckDB.NET.Data;
using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Records;

/// <summary>Reads the <c>winners</c> table directly because where the answer is stored is the point
/// (ADR-0001: winning is a function of the registered load order, never a column on a data row).</summary>
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

        // The table is a function, not a set of flags: (record_ref, form_key) is its key, so a reader can
        // LEFT JOIN it without risking a duplicated record row.
        Assert.Equal(2, Scalar(index, $"SELECT COUNT(*) FROM winners WHERE form_key = '{_npc}'"));

        // Every plugin header wins its own FormKey, swept by construction as an ordinary `records` row.
        // Still asserted, because "no winner" reads as "no header exists" through Open Header's
        // winner-only lookup.
        foreach (var plugin in new[] { BaseKey, OverKey })
        {
            var headerFk = PluginHeader.FormKeyFor(ModKey.FromFileName(plugin.Name));
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
        Assert.Equal(BaseKey.Name, index.At(RecordRef.Effective).GetDocument(_npc)!.Plugin.Name);

        index.Register(OverKey, Registration.Participating(1));
        index.UpdateWinners();

        Assert.Equal(Expected(OverKey), WinnerOf(index, RecordRef.Effective, _npc));
        Assert.Equal(OverKey.Name, index.At(RecordRef.Effective).GetDocument(_npc)!.Plugin.Name);
    }

    [Fact]
    public void AnUnregisteredPlugin_WinsNothing_EvenThoughItsRowsAreStillThere()
    {
        using var index = LoadedIndex();

        index.Unregister(OverKey);
        index.UpdateWinners();

        Assert.True(Scalar(index, $"SELECT COUNT(*) FROM mirror.records WHERE plugin = '{OverKey.Name}'") > 0,
            "Premise: unregistering leaves the index rows in place.");
        Assert.Equal(0, Scalar(index, $"SELECT COUNT(*) FROM winners WHERE plugin = '{OverKey.Name}'"));
        Assert.Equal(Expected(BaseKey), WinnerOf(index, RecordRef.Effective, _npc));
    }

    [Fact]
    public void SeedCommittedOnly_GivesTheRecordItAddsAtHead_AWinnerThere()
    {
        using var index = LoadedIndex();
        var baseBody = index.At(RecordRef.Effective).GetDocument(_npc, BaseKey)!.Body!;

        // Both plugins' copies vanish from the working tree and turn out to be held by no commit
        // either, so nothing holds the NPC at either ref...
        index.ProjectDocuments(OverKey, [(_npc, null)]);
        index.ProjectDocuments(BaseKey, [(_npc, null)]);
        index.MarkWorkingTreeOnly(OverKey, [_npc]);
        index.MarkWorkingTreeOnly(BaseKey, [_npc]);
        Assert.Null(WinnerOf(index, RecordRef.Effective, _npc));
        Assert.Null(index.At(RecordRef.Head).GetDocument(_npc));

        // Base.esm, not the plugin that had been winning: a stale winners table naming Over.esp
        // would leave this row losing to a plugin holding nothing at Head.
        index.SeedCommittedOnly(BaseKey, [(_npc, "npc_", baseBody)]);

        Assert.Equal(Expected(BaseKey), WinnerOf(index, RecordRef.Head, _npc));
        Assert.Equal(BaseKey.Name, index.At(RecordRef.Head).GetDocument(_npc)!.Plugin.Name);
        Assert.Null(WinnerOf(index, RecordRef.Effective, _npc));
    }

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
        Assert.Equal(OverKey.Name, index.At(RecordRef.Effective).GetDocument(_npc)!.Plugin.Name);
    }
}
