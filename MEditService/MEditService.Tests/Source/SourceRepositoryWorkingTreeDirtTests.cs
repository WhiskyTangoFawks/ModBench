using MEditService.LoadOrder;
using MEditService.SourceRepo;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Tests.Source;

/// <summary>What the tree's own dirt says about records, which is how a reconcile learns where Head
/// stands (ADR-0003): identity and text, never a path or a porcelain line.</summary>
public sealed class SourceRepositoryWorkingTreeDirtTests
{
    private static WorkingTreeDirt DirtOf(IndexedModFixture mod) =>
        SourceRepository.Open(mod.ModFolder, GameRelease.Fallout4)!.DirtOf(mod.Plugin);

    [Fact]
    public void DirtOf_AFreshlyTrackedTree_IsClean()
    {
        using var mod = IndexedModFixture.Tracked();

        var dirt = DirtOf(mod);

        Assert.Empty(dirt.Documents);
        Assert.False(dirt.NeedsStructuralPass);
    }

    [Fact]
    public void DirtOf_AHandEditedRecord_NamesItWithTheTextHeadCommits()
    {
        using var mod = IndexedModFixture.Tracked();
        var committed = File.ReadAllText(mod.NpcSourceFile);
        File.WriteAllText(
            mod.NpcSourceFile,
            committed.Replace(IndexedModFixture.NpcEditorId, "HandRenamed", StringComparison.Ordinal));

        var dirt = DirtOf(mod);

        var document = Assert.Single(dirt.Documents);
        Assert.Equal(mod.Npc.ToString(), document.FormKey);
        // The schema table's own name, which is what the group folder is named after.
        Assert.Equal("npc_", document.RecordType);
        Assert.True(document.InWorkingTree);
        Assert.Contains(IndexedModFixture.NpcEditorId, document.CommittedText!, StringComparison.Ordinal);
        Assert.False(dirt.NeedsStructuralPass);
    }

    [Fact]
    public void DirtOf_AWorkingTreeDeletion_NamesTheRecordAsGoneFromTheTree()
    {
        using var mod = IndexedModFixture.Tracked();
        File.Delete(mod.NpcSourceFile);

        var dirt = DirtOf(mod);

        var document = Assert.Single(dirt.Documents);
        Assert.Equal(mod.Npc.ToString(), document.FormKey);
        Assert.False(document.InWorkingTree);
        Assert.NotNull(document.CommittedText);
    }

    // The ordinary shape of a create: the write path never runs git add, so the file is untracked and
    // no ref holds its text.
    [Fact]
    public void DirtOf_ADocumentNoRefHolds_NamesItWithNoCommittedText()
    {
        using var mod = IndexedModFixture.Tracked();
        var created = Path.Combine(
            Path.GetDirectoryName(mod.NpcSourceFile)!, $"Created - 000FFF_{mod.ActualPluginName}.json");
        File.WriteAllText(created, $"{{\"FormKey\":\"000FFF:{mod.ActualPluginName}\",\"EditorID\":\"Created\"}}");

        var dirt = DirtOf(mod);

        var document = Assert.Single(dirt.Documents);
        Assert.Equal($"000FFF:{mod.ActualPluginName}", document.FormKey);
        Assert.True(document.InWorkingTree);
        Assert.Null(document.CommittedText);
    }
}
