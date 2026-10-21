using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceAdapter.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.SourceAdapter.Tests.Source;

public sealed class SourceRepositoryRelativePathOfTests : IDisposable
{
    private const string PluginName = "Fixture.esp";
    private static readonly PluginAddress Plugin = new(PluginName, TestMod.Name);
    private static readonly string HeaderPath = PluginSourceRoot.HeaderDocument(PluginName);

    private readonly ScratchDirectory _modFolder = new("medit-relative-path-of-");

    public void Dispose() => _modFolder.Dispose();

    private ISourceRepository SourceMod()
    {
        var header = new TreeFile(HeaderPath, "{\"MasterReferences\": []}"u8.ToArray());
        PluginBaselines.Init(
            _modFolder, [header]);
        return TestAdapters.OpenSourceMod(_modFolder, GameRelease.Fallout4);
    }

    [Fact]
    public void RelativePathOf_AHeaderFormKey_IsTheRootDocument_ThoughItHasNoGroupFolderOrFormKeyInItsFileName()
    {
        var repository = SourceMod();
        var headerFormKey = PluginHeader.FormKeyFor(ModKey.FromFileName(PluginName));

        Assert.Equal(
            HeaderPath,
            repository.RelativePathOf(Plugin, new RecordIdentity(headerFormKey, PluginHeader.RecordType, EditorId: null)).Value());
    }

    [Fact]
    public void Remove_TheHeader_TakesItsDocumentAlone_ThoughItSharesItsFileNameWithAContainersDocument()
    {
        var repository = SourceMod();
        var neighbour = Path.Combine(PluginSourceRoot.In(_modFolder, PluginName), "Npcs", "Neighbour - 000800_Fixture.esp.json");
        Directory.CreateDirectory(Path.GetDirectoryName(neighbour).Require());
        File.WriteAllText(neighbour, "{\"FormKey\": \"000800:Fixture.esp\", \"EditorID\": \"Neighbour\"}");
        var headerFormKey = PluginHeader.FormKeyFor(ModKey.FromFileName(PluginName));

        repository.Remove(Plugin, new RecordIdentity(headerFormKey, PluginHeader.RecordType, EditorId: null)).Wrote();

        Assert.False(File.Exists(Path.Combine(_modFolder, HeaderPath)));
        Assert.True(File.Exists(neighbour));
    }

    [Fact]
    public void RelativePathOf_AnEmbeddedRecordNoDocumentCarries_AnswersNothing_ForAnEmbeddedTypeHasNoFileOfItsOwn()
    {
        var repository = SourceMod();

        Assert.Null(repository.RelativePathOf(Plugin, new RecordIdentity($"FFFFFF:{PluginName}", "PlacedObject", EditorId: null)).Value());
    }
}
