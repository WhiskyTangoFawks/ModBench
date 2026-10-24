using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceAdapter.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.SourceAdapter.Tests.Source;

public sealed class SourceRepositoryRefusedFilesTests : IDisposable
{
    private const string PluginName = "Refused.esp";
    private static readonly PluginAddress Plugin = new(PluginName, TestMod.Name);
    private static readonly string HeaderPath = PluginSourceRoot.HeaderDocument(PluginName);
    private static readonly string BlockPath = Path.Combine(PluginSourceRoot.For(PluginName), "Cells", "8", "GroupRecordData.json");

    private readonly ScratchDirectory _modFolder = new("medit-refused-files-");

    public SourceRepositoryRefusedFilesTests()
    {
        PluginBaselines.Init(
            _modFolder, [new TreeFile(HeaderPath, HeaderDocument.Write(new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4)))]);
        Repository.Put(Plugin, new SourceDocument("000800:Refused.esp", "cell", "Room", "{\n  \"FormKey\": \"000800:Refused.esp\",\n  \"EditorID\": \"Room\"\n}")).Wrote();
    }

    public void Dispose() => _modFolder.Dispose();

    private ISourceRepository Repository => TestAdapters.OpenSourceMod(_modFolder, GameRelease.Fallout4);

    private void Rewrite(string relativePath, string from, string to)
    {
        var path = Path.Combine(_modFolder, relativePath);
        var text = File.ReadAllText(path);
        var edited = text.Replace(from, to, StringComparison.Ordinal);
        Assert.NotEqual(text, edited);
        File.WriteAllText(path, edited);
    }

    [Fact]
    public void ATreeTheCodecReadsThrough_RefusesNoFile()
    {
        Assert.Empty(Repository.RefusedFilesOf(Plugin).Value());
    }

    [Fact]
    public void ABlockLevelDocumentWithAFieldMisspelled_IsRefusedByItsPathInTheSourceFolder_NamingTheField()
    {
        Rewrite(BlockPath, "BlockNumber", "BlockNumbr");

        var refused = Assert.Single(Repository.RefusedFilesOf(Plugin).Value());

        Assert.Equal(BlockPath, refused.Path);
        Assert.Contains("BlockNumbr", refused.Reason, StringComparison.Ordinal);
    }

    [Fact]
    public void AMalformedHeader_IsRefusedByItsFileAsTheLayoutSpellsIt()
    {
        Rewrite(HeaderPath, "\"Stats\": {", "\"Stats\": {\n      \"Version\": \"x\",");

        var refused = Assert.Single(Repository.RefusedFilesOf(Plugin).Value());

        Assert.Equal(HeaderPath, refused.Path);
    }
}
