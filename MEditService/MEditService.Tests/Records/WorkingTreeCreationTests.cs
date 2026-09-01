using System.Text;
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
/// <see cref="IRecordIndex.CreateWorkingTreeRecord"/> materializes a record
/// <see cref="IRecordIndex.ApplyWorkingTreeChanges"/> deliberately refuses to — one that exists at
/// neither ref yet. The sharp questions mirror <see cref="WorkingTreeDeletionTests"/>'s own: does the
/// new row answer everywhere a record is supposed to (Effective, winner, lookup, references) while
/// staying invisible at Head, since nothing has been committed.
/// </summary>
public sealed class WorkingTreeCreationTests : IDisposable
{
    private static readonly SchemaReflector Reflector = SharedSchemaReflector.Instance;
    private static readonly TableDdlBuilder Ddl = new TableDdlBuilder(Reflector);

    private static readonly PluginKey BaseKey = new("Base.esm", "Data");
    private static readonly PluginKey WinnerKey = new("Winner.esp", "Data");

    private readonly PluginFixtureData _fixture;

    public WorkingTreeCreationTests()
    {
        _fixture = new PluginFixtureBuilder("working-tree-creation")
            .WithPlugin("Base.esm", mod => mod.Races.AddNew("RaceA"))
            .WithPlugin("Winner.esp", (mod, built) =>
            {
                mod.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName("Base.esm") });
            })
            .Build();
    }

    public void Dispose() => _fixture.Dispose();

    private DuckDbRecordIndex LoadedIndex()
    {
        var index = new DuckDbRecordIndex(Reflector, Ddl, NullLogger.Instance);
        index.Initialize(GameRelease.Fallout4);
        Open(index, "Base.esm", 0);
        Open(index, "Winner.esp", 1);
        index.UpdateWinners();
        return index;
    }

    private void Open(DuckDbRecordIndex index, string name, int loadOrderIndex)
    {
        var path = new ModPath(ModKey.FromFileName(name), Path.Combine(_fixture.DataFolder, name));
        index.Index(
            Fallout4Mod.CreateFromBinaryOverlay(path, Fallout4Release.Fallout4), Registration.Participating(loadOrderIndex), new PluginKey(name, "Data"));
    }

    // A real codec-produced body, the same shape CreateRecord will write in production — a
    // hand-crafted JSON literal would only prove the test author's guess at the codec's shape, not
    // that a genuinely new record round-trips through RederiveIndexRowsForRecord's own deserialize.
    private static readonly RecordTextCodec Codec = new(NullLogger<RecordTextCodec>.Instance);

    private static string NewNpcBody(string formKey, string editorId)
    {
        var npc = new Npc(FormKey.Factory(formKey), Fallout4Release.Fallout4) { EditorID = editorId };
        var bytes = Codec.SerializeToBytesAsync(npc, GameRelease.Fallout4).GetAwaiter().GetResult();
        return Encoding.UTF8.GetString(bytes);
    }

    [Fact]
    public void CreatingARecord_AppearsAtEffective_AndIsAbsentAtHead()
    {
        using var index = LoadedIndex();
        var formKey = "800000:Base.esm";

        index.CreateWorkingTreeRecord(BaseKey, formKey, "npc_", NewNpcBody(formKey, "NewNpc"));

        var effective = index.At(RecordRef.Effective).GetDocument(formKey, BaseKey);
        Assert.NotNull(effective);
        Assert.Equal("NewNpc", effective!.EditorId);
        Assert.Null(index.At(RecordRef.Head).GetDocument(formKey, BaseKey));
    }

    [Fact]
    public void CreatingARecord_IsWinner_WhenNothingElseHoldsThatFormKey()
    {
        using var index = LoadedIndex();
        var formKey = "800000:Base.esm";

        index.CreateWorkingTreeRecord(BaseKey, formKey, "npc_", NewNpcBody(formKey, "NewNpc"));

        // An implementation that inserts the row but skips the structural
        // UpdateWinners() resweep never gives the new FormKey a winners row at all, so it reads as
        // losing forever — this is the test that catches that omission.
        Assert.True(index.At(RecordRef.Effective).GetDocument(formKey)!.IsWinner);
    }

    [Fact]
    public void CreatingARecord_DerivesFormLookup_SoItResolves()
    {
        using var index = LoadedIndex();
        var formKey = "800000:Winner.esp";

        Assert.Null(index.At(RecordRef.Effective).Resolve(formKey));

        index.CreateWorkingTreeRecord(WinnerKey, formKey, "npc_", NewNpcBody(formKey, "BrandNew"));

        var resolved = index.At(RecordRef.Effective).Resolve(formKey);
        Assert.NotNull(resolved);
        Assert.Equal("BrandNew", resolved!.Value.EditorId);
    }

    [Fact]
    public void CreatingARecord_ThatAlreadyExistsAtEffective_Throws()
    {
        using var index = LoadedIndex();
        var existing = index.At(RecordRef.Effective).GetDocument(index.At(RecordRef.Effective).GetNativeFormKeys(BaseKey)[0], BaseKey)!;

        Assert.Throws<ArgumentException>(() =>
            index.CreateWorkingTreeRecord(BaseKey, existing.FormKey, existing.RecordType, existing.Body!));
    }

    [Fact]
    public void CreatingARecord_ThatExistsOnlyAtHead_BecauseTheWorkingTreeDeletedIt_Throws()
    {
        using var index = LoadedIndex();
        var deleted = index.At(RecordRef.Effective).GetNativeFormKeys(BaseKey)[0];
        var recordType = index.At(RecordRef.Effective).GetDocument(deleted, BaseKey)!.RecordType;
        index.ApplyWorkingTreeChanges(BaseKey, [(deleted, null)]);
        Assert.Null(index.At(RecordRef.Effective).GetDocument(deleted, BaseKey)); // gone at Effective...
        Assert.NotNull(index.At(RecordRef.Head).GetDocument(deleted, BaseKey)); // ...still at Head

        Assert.Throws<ArgumentException>(() =>
            index.CreateWorkingTreeRecord(BaseKey, deleted, recordType, NewNpcBody(deleted, "Reused")));
    }
}
