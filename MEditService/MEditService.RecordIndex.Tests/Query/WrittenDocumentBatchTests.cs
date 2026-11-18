using System.Text.Json.Nodes;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.SourceAdapter;
using MEditService.TestSupport;

namespace MEditService.RecordIndex.Tests.Query;

public sealed class WrittenDocumentBatchTests : IDisposable
{
    private const long MemoryLimit = 64_000_000;
    private const int MoreThanHalfABatch = 1_500_000;
    private const string Added = "000F00:ContainerFixture.esp";

    private readonly ContainerMod _mod = new();
    private readonly ScratchDirectory _instance = new("medit-written-document-batch-");

    public void Dispose()
    {
        _instance.Dispose();
        _mod.Dispose();
    }

    [Fact]
    public void ADocumentAWriteGrowsAndOneItAdds_AreReadInABatchEach()
    {
        using var index = Indexes.Reconciled(_mod.DataFolder, [_mod.Entry], _instance, memoryLimit: MemoryLimit);
        var npc = _mod.Npc.ToString();
        var grown = Named(index.BodyOf(npc, _mod.Plugin));
        var added = grown.Replace(npc, Added, StringComparison.Ordinal).Replace($"\"{ContainerMod.NpcEditorId}\"", "\"Added\"", StringComparison.Ordinal);
        var repository = SourceMods.RepositoryOf(_mod.Entry);
        repository.Put(_mod.Plugin, new SourceDocument(npc, "npc_", ContainerMod.NpcEditorId, grown)).Wrote();
        repository.Put(_mod.Plugin, new SourceDocument(Added, "npc_", "Added", added)).Wrote();

        index.SignalChange([new PluginChange(_mod.Plugin, [
            _mod.Entry.SourceFileOf(new RecordIdentity(npc, "npc_", ContainerMod.NpcEditorId)),
            _mod.Entry.SourceFileOf(new RecordIdentity(Added, "npc_", "Added"))])]);
        Waits.Reached(() => index.CopyIn(Added, _mod.Plugin) is not null && !index.Status.Validating, "the watch's read");
        IndexFiles.LogQueries(_instance);

        Assert.Equal(2, index.Queries.GetCopyStates([npc, Added], _mod.Plugin).Value().Count);
        Assert.Equal(2L, IndexFiles.StartedCount(_instance, "body"));
    }

    private static string Named(string body)
    {
        var document = JsonNode.Parse(body).Require().AsObject();
        document["Name"] = new string('x', MoreThanHalfABatch);
        return document.ToJsonString();
    }
}
