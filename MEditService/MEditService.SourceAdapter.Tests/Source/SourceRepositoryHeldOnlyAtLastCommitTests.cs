using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceAdapter.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.SourceAdapter.Tests.Source;

public sealed class SourceRepositoryHeldOnlyAtLastCommitTests : IDisposable
{
    private const string PluginName = "Held.esp";
    private const string FormKey = "000800:Held.esp";

    private static readonly PluginAddress Plugin = new(PluginName, "HeldMod");
    private static readonly RecordIdentity Npc = new(FormKey, "npc_", "HeldNpc");
    private static readonly SourceDocument NpcDocument = new(FormKey, "npc_", "HeldNpc", "{\"FormKey\": \"000800:Held.esp\", \"EditorID\": \"HeldNpc\"}");

    private readonly ScratchDirectory _modFolder = new("medit-held-at-last-commit-");

    public void Dispose() => _modFolder.Dispose();

    private SourceRepository TrackedWithTheRecordCommitted()
    {
        PluginBaselines.Track(_modFolder, SourcePreset.Edits, [new TreeFile($"plugin-source/{PluginName}/Npcs/HeldNpc - 000800_Held.esp.json", System.Text.Encoding.UTF8.GetBytes(NpcDocument.Body))]);
        return SourceRepository.Open(_modFolder, GameRelease.Fallout4)
            ?? throw new InvalidOperationException($"Expected '{_modFolder}' to be tracked.");
    }

    [Fact]
    public void ARecordTheTreeHasDeletedSinceTheLastCommit_IsHeldOnlyThere()
    {
        var repository = TrackedWithTheRecordCommitted();
        repository.Remove(Plugin, Npc);

        Assert.True(repository.HeldOnlyAtLastCommit(Plugin, FormKey));
    }

    [Fact]
    public void ARecordTheTreeStillHolds_IsNotHeldOnlyAtTheLastCommit()
    {
        var repository = TrackedWithTheRecordCommitted();

        Assert.False(repository.HeldOnlyAtLastCommit(Plugin, FormKey));
    }

    [Fact]
    public void ARecordOnlyTheTreeHolds_IsNotHeldAtTheLastCommit()
    {
        var repository = TrackedWithTheRecordCommitted();
        repository.Put(Plugin, new SourceDocument("000801:Held.esp", "npc_", "NewNpc", "{\"FormKey\": \"000801:Held.esp\", \"EditorID\": \"NewNpc\"}"));

        Assert.False(repository.HeldOnlyAtLastCommit(Plugin, "000801:Held.esp"));
    }

    [Fact]
    public void ARecordNeitherHolds_IsNotHeldOnlyAtTheLastCommit()
    {
        var repository = TrackedWithTheRecordCommitted();

        Assert.False(repository.HeldOnlyAtLastCommit(Plugin, "000802:Held.esp"));
    }

    [Fact]
    public void AnEmbeddedChildTheTreeHasTakenOutOfItsOwner_IsHeldOnlyAtTheLastCommit_AndItsOwnerIsNot()
    {
        var folder = RecordTypeDispatch.For(GameRelease.Fallout4).FolderNameFor("globalfloat")
            ?? throw new InvalidOperationException("Expected 'globalfloat' to resolve to a group folder.");
        var relativePath = Path.Combine(PluginSourceRoot.For(PluginName), folder, "Carrier - 00A000_Held.esp.json");
        const string withTheChild =
            "{\n  \"MutagenObjectType\": \"GlobalFloat\",\n  \"FormKey\": \"00A000:Held.esp\",\n  \"Temporary\": [ { \"FormKey\": \"00A001:Held.esp\" } ]\n}";
        PluginBaselines.Track(_modFolder, SourcePreset.Edits, [new TreeFile(relativePath, System.Text.Encoding.UTF8.GetBytes(withTheChild))]);
        var repository = SourceRepository.Open(_modFolder, GameRelease.Fallout4)
            ?? throw new InvalidOperationException($"Expected '{_modFolder}' to be tracked.");
        File.WriteAllText(
            Path.Combine(_modFolder, relativePath),
            "{\n  \"MutagenObjectType\": \"GlobalFloat\",\n  \"FormKey\": \"00A000:Held.esp\"\n}");

        Assert.True(repository.HeldOnlyAtLastCommit(Plugin, "00A001:Held.esp"));
        Assert.False(repository.HeldOnlyAtLastCommit(Plugin, "00A000:Held.esp"));
    }
}
