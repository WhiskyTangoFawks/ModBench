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
    private static readonly string MetaPath = Path.Combine(PluginSourceRoot.For(PluginName), SpriggitMeta.FileName);
    private static readonly string BlockPath = Path.Combine(PluginSourceRoot.For(PluginName), "Cells", "8", "GroupRecordData.json");

    private readonly ScratchDirectory _modFolder = new("medit-refused-files-");

    public SourceRepositoryRefusedFilesTests()
    {
        PluginBaselines.Init(
            _modFolder,
            [
                new TreeFile(HeaderPath, HeaderDocument.Write(new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4))),
                PluginBaselines.MetaFor(PluginName),
            ]);
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
    public void ABlockLevelDocumentWithAFieldMisspelled_IsRefusedByItsPathInTheSourceFolder_NamingTheField()
    {
        Rewrite(BlockPath, "BlockNumber", "BlockNumbr");

        var refused = Assert.Single(Repository.TreeOf(Plugin).Value().RefusedFiles().Value());

        Assert.Equal(BlockPath, refused.Path);
        Assert.Contains("BlockNumbr", refused.Reason, StringComparison.Ordinal);
    }

    [Fact]
    public void ARecordDocumentInAnotherTypesFolder_IsRefusedByItsFile_WithoutExceptionText()
    {
        Repository.Put(Plugin, new SourceDocument("000801:Refused.esp", "misc", "Coin", "{\n  \"FormKey\": \"000801:Refused.esp\",\n  \"EditorID\": \"Coin\",\n  \"Weight\": 2\n}")).Wrote();
        var held = SourceDocumentPath.Of(_modFolder, PluginName, "misc", "000801:Refused.esp", "Coin", GameRelease.Fallout4);
        var misfiled = held.Replace("MiscItems", "Globals", StringComparison.Ordinal);
        Assert.NotEqual(held, misfiled);
        _ = Directory.CreateDirectory(Path.GetDirectoryName(misfiled) ?? "");
        File.Move(held, misfiled);

        var refused = Assert.Single(Repository.TreeOf(Plugin).Value().RefusedFiles().Value());

        Assert.Equal(Path.GetRelativePath(_modFolder, misfiled), refused.Path);
        Assert.DoesNotContain("Object reference", refused.Reason, StringComparison.Ordinal);
    }

    [Fact]
    public void AMalformedHeader_IsRefusedByItsFileAsTheLayoutSpellsIt()
    {
        Rewrite(HeaderPath, "\"GameRelease\": \"Fallout4\"", "\"GameRelease\": \"Fallout4\",\n  \"ModHeader\": { \"Stats\": { \"Version\": \"x\" } }");

        var refused = Assert.Single(Repository.TreeOf(Plugin).Value().RefusedFiles().Value());

        Assert.Equal(HeaderPath, refused.Path);
    }

    [Fact]
    public void AMetaOfAnotherVersion_IsRefusedByItsFile_AndHoldsTheOnlyRefusal()
    {
        Rewrite(BlockPath, "BlockNumber", "BlockNumbr");
        Rewrite(MetaPath, GameCodecs.For(GameRelease.Fallout4).SpriggitVersion, "0.1.0");

        var refused = Assert.Single(Repository.TreeOf(Plugin).Value().RefusedFiles().Value());

        Assert.Equal(MetaPath, refused.Path);
    }

    [Fact]
    public void ASourceWithNoMeta_IsRefusedByTheFileItLacks()
    {
        File.Delete(Path.Combine(_modFolder, MetaPath));

        var refused = Assert.Single(Repository.TreeOf(Plugin).Value().RefusedFiles().Value());

        Assert.Equal(MetaPath, refused.Path);
    }
}
