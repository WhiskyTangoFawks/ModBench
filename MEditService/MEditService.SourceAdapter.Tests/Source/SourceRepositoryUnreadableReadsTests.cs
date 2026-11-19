using System.Text;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceAdapter.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.SourceAdapter.Tests.Source;

public sealed class SourceRepositoryUnreadableReadsTests : IDisposable
{
    private const string PluginName = "Unreadable.esp";
    private static readonly PluginAddress Plugin = new(PluginName, TestMod.Name);
    private static readonly GameRelease Release = GameRelease.Fallout4;

    private readonly ScratchDirectory _modFolder = new("medit-unreadable-reads-");
    private readonly Fallout4Mod _mod = new(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);

    public void Dispose() => _modFolder.Dispose();

    private static string Root => PluginSourceRoot.For(PluginName);

    private ISourceRepository SourceMod(params TreeFile[] files)
    {
        PluginBaselines.Init(_modFolder, files);
        return TestAdapters.OpenSourceMod(_modFolder, Release);
    }

    private string Unreadable(string relativePath)
    {
        FileModes.Set(Path.Combine(_modFolder, relativePath), "000");
        return relativePath;
    }

    private (string Path, byte[] Text) CellWithAReference(out PlacedObject reference)
    {
        reference = new PlacedObject(_mod) { EditorID = "Ref" };
        var cell = new Cell(_mod) { EditorID = "Room" };
        cell.Temporary.Add(reference);
        return (
            PluginSourceRoot.ContainerDocument(Path.Combine(Root, "Cells", "0", "0", PluginSourceRoot.Leaf(cell))),
            Encoding.UTF8.GetBytes(RecordTextCodec.SerializeToText(cell, Release)));
    }

    private static byte[] NpcText(string editorId) =>
        Encoding.UTF8.GetBytes($"{{\"FormKey\": \"000850:{PluginName}\", \"EditorID\": \"{editorId}\"}}");

    private static void AssertStoppedNaming(string relativePath, SourceFailure stopped) =>
        Assert.Contains(relativePath, Assert.IsType<SourceFailure.Inaccessible>(stopped).Reason);

    [PosixTheory]
    [InlineData("Hidden - 000850_Unreadable.esp.json")]
    [InlineData("RenamedByHand.json")]
    public void ARecordByFormKey_WhoseDocumentIsUnreadable_NamedForItOrNot_StopsNamingIt(string leaf)
    {
        var npc = Path.Combine(Root, "Npcs", leaf);
        var repository = SourceMod(new TreeFile(npc, NpcText("Hidden")));

        AssertStoppedNaming(Unreadable(npc), repository.RecordByFormKey(Plugin, $"000850:{PluginName}").Stopped());
    }

    [PosixFact]
    public void AnEmbeddedChildByFormKey_WhoseOwnerIsUnreadable_StopsNamingTheOwner()
    {
        var (cellPath, cell) = CellWithAReference(out var reference);
        var repository = SourceMod(new TreeFile(cellPath, cell));

        AssertStoppedNaming(Unreadable(cellPath), repository.RecordByFormKey(Plugin, reference.FormKey.ToString()).Stopped());
    }

    [PosixFact]
    public void AnEmbeddedChildByFormKey_WhoseOwnerTurnsUnreadableAfterTheScan_StopsNamingTheOwner()
    {
        var (cellPath, cell) = CellWithAReference(out var reference);
        var repository = SourceMod(new TreeFile(cellPath, cell));
        Assert.NotNull(repository.RecordByFormKey(Plugin, reference.FormKey.ToString()).Value());

        AssertStoppedNaming(Unreadable(cellPath), repository.RecordByFormKey(Plugin, reference.FormKey.ToString()).Stopped());
    }
}
