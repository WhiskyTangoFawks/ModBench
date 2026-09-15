using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.SourceRepo;
using MEditService.Tests.Edits;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Source;

/// <summary>Which unit holds a record, as a caller outside the repository is told it: embedded or
/// not, whose document it is, directory-per-record or not, and that document's path.</summary>
public sealed class SourceRepositoryUnitHoldingTests
{
    // The header has no group folder and carries no FormKey in its file name, so every other
    // resolution branch answers null for it.
    [Fact]
    public void UnitHolding_AHeaderFormKey_IsItsOwnUndeletableDocument()
    {
        using var mod = SourceEditFixture.Tracked();
        var headerFormKey = PluginHeader.FormKeyFor(ModKey.FromFileName(mod.ActualPluginName));
        var identity = new RecordIdentity(headerFormKey, PluginHeader.RecordType, EditorId: null);
        var repository = SourceRepository.Open(mod.ModFolder, GameRelease.Fallout4)!;

        var unit = repository.UnitHolding(mod.Plugin, identity);

        Assert.NotNull(unit);
        Assert.False(unit.IsEmbedded);
        Assert.Equal(headerFormKey, unit.OwnerFormKey);
        Assert.Equal(PluginHeader.RecordType, unit.OwnerRecordType);
        // Filename-only, the header's root RecordData.json shares the name a container's document has.
        Assert.False(unit.IsDirectoryPerRecord);
        // From the same read as the facts, so nothing can move between them and the path a refusal names.
        Assert.Equal(Path.Combine("source", mod.ActualPluginName, "RecordData.json"), unit.RelativePath);
    }

    // An embedded type has no file of its own, so nothing is computed for it: either a document in the
    // tree carries it or no unit holds it at all.
    [Fact]
    public void UnitHolding_AnEmbeddedRecordNoDocumentCarries_AnswersNothing()
    {
        using var mod = SourceEditFixture.Tracked();
        var repository = SourceRepository.Open(mod.ModFolder, GameRelease.Fallout4)!;

        var unit = repository.UnitHolding(
            mod.Plugin, new RecordIdentity($"FFFFFF:{mod.ActualPluginName}", "PlacedObject", EditorId: null));

        Assert.Null(unit);
    }
}
