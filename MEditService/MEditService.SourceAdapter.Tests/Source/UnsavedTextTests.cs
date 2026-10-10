using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceAdapter.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.SourceAdapter.Tests.Source;

public sealed class UnsavedTextTests : IDisposable
{
    private const GameRelease Release = GameRelease.Fallout4;
    private const string PluginName = "Vendor.esp";
    private const string Npc = "000800:Vendor.esp";
    private const string Worldspace = "000801:Vendor.esp";
    private const string Cell = "000802:Vendor.esp";

    private static readonly PluginAddress Plugin = new(PluginName, TestMod.Name);

    private readonly ScratchDirectory _modFolder = new("medit-unsaved-");
    private readonly UnsavedDocuments _unsaved = new();

    public UnsavedTextTests()
    {
        PluginBaselines.TrackWithNoRecords(_modFolder);
        Repository.Put(Plugin, new SourceDocument(Npc, "npc_", "VendorNpc", NpcBody("VendorNpc"))).Wrote();
    }

    public void Dispose() => _modFolder.Dispose();

    private ISourceRepository Repository => TestAdapters.Source().OverFolder(TestMod.In(_modFolder), Release);

    private ISourceRepositoryReads Reads =>
        new GitSourceAdapter(_unsaved).Over(new RegisteredPlugin(PluginName, TestMod.Name, Path.Combine(_modFolder, PluginName), TestMod.In(_modFolder), Line: null), Release)
        ?? throw new InvalidOperationException("Expected a mod to provide the plugin.");

    private static string NpcBody(string editorId) => $"{{\n  \"FormKey\": \"{Npc}\",\n  \"EditorID\": \"{editorId}\"\n}}";

    private static string CellBody(string grid) => $"{{\n  \"FormKey\": \"{Cell}\",\n  \"Grid\": {{\n    \"Point\": \"{grid}\"\n  }}\n}}";

    private string FileOf(string formKey, string recordType) =>
        Repository.DocumentOf(Plugin, new RecordIdentity(formKey, recordType, null)).Value()?.Path
        ?? throw new InvalidOperationException($"Expected a file to hold {formKey}.");

    [Fact]
    public async Task StampsOf_ASettledFile_IsTheTextHeldInItsPlace_AndItsBytesOnceDropped()
    {
        await Task.Delay(TimeSpan.FromSeconds(2.2));
        Reads.StampsOf(Plugin);

        _unsaved.Apply([new DocumentChange(FileOf(Npc, "npc_"), NpcBody("TypedNpc"))]);
        var held = Reads.StampsOf(Plugin).ByFormKey[Npc];
        _unsaved.Apply([]);
        var dropped = Reads.StampsOf(Plugin).ByFormKey[Npc];

        Assert.Equal(SourceRepository.ContentStamp(NpcBody("TypedNpc")), held);
        Assert.Equal(SourceRepository.ContentStamp(NpcBody("VendorNpc")), dropped);
    }

    [Fact]
    public void GetCellAt_InASession_IsTheCellWhoseUnsavedTextNamesTheGrid()
    {
        Repository.Put(Plugin, new SourceDocument(Worldspace, "wrld", null, $"{{\n  \"FormKey\": \"{Worldspace}\"\n}}")).Wrote();
        Repository.PutInWorldspace(Plugin, new SourceDocument(Cell, "cell", null, CellBody("9, -9")), Worldspace);

        var session = TestAdapters.Source().WriteSessionOver(TestMod.In(_modFolder), Release, [new DocumentChange(FileOf(Cell, "cell"), CellBody("10, -9"))]);

        Assert.Equal(Cell, session.Repository.GetCellAt(Plugin, Worldspace, 10, -9).Value()?.FormKey);
    }
}
