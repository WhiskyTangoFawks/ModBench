using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceAdapter.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.SourceAdapter.Tests.Source;

public sealed class SourceRepositoryUnitHoldingTests : IDisposable
{
    private const string PluginName = "Fixture.esp";
    private static readonly PluginAddress Plugin = new(PluginName, "FixtureMod");
    private static readonly string HeaderPath = Path.Combine("plugin-source", PluginName, "RecordData.json");

    private readonly ScratchDirectory _modFolder = new("medit-unitholding-");

    public void Dispose() => _modFolder.Dispose();

    private SourceRepository Tracked()
    {
        var header = new TreeFile(HeaderPath, "{\"MasterReferences\": []}"u8.ToArray());
        PluginBaselines.Track(
            _modFolder, SourcePreset.Edits, [header]);
        return SourceRepository.Open(_modFolder, GameRelease.Fallout4)
            ?? throw new InvalidOperationException($"Expected '{_modFolder}' to already be tracked.");
    }

    [Fact]
    public void UnitHolding_AHeaderFormKey_IsItsOwnUndeletableDocument_ThoughItHasNoGroupFolderOrFormKeyInItsFileName()
    {
        var repository = Tracked();
        var headerFormKey = PluginHeader.FormKeyFor(ModKey.FromFileName(PluginName));
        var identity = new RecordIdentity(headerFormKey, PluginHeader.RecordType, EditorId: null);

        var unit = repository.UnitHolding(Plugin, identity);

        Assert.NotNull(unit);
        Assert.False(unit.IsEmbedded);
        Assert.Equal(headerFormKey, unit.OwnerFormKey);
        Assert.Equal(PluginHeader.RecordType, unit.OwnerRecordType);
        Assert.False(unit.IsDirectoryPerRecord, "the header's root RecordData.json shares the file name a container's document has");
        Assert.Equal(HeaderPath, unit.RelativePath);
    }

    [Fact]
    public void UnitHolding_AnEmbeddedRecordNoDocumentCarries_AnswersNothing_ForAnEmbeddedTypeHasNoFileOfItsOwn()
    {
        var repository = Tracked();

        var unit = repository.UnitHolding(Plugin, new RecordIdentity($"FFFFFF:{PluginName}", "PlacedObject", EditorId: null));

        Assert.Null(unit);
    }
}
