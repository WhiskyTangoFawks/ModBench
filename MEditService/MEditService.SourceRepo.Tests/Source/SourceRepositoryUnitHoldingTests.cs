using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceRepo;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.SourceRepo.Tests.Source;

/// <summary>Which unit holds a record, as a caller outside the repository is told it: embedded or
/// not, whose document it is, directory-per-record or not, and that document's path.</summary>
public sealed class SourceRepositoryUnitHoldingTests : IDisposable
{
    private const string PluginName = "Fixture.esp";
    private static readonly PluginCopyKey Plugin = new(PluginName, "FixtureMod");
    private static readonly string HeaderPath = Path.Combine("source", PluginName, "RecordData.json");

    private readonly string _modFolder = Directory.CreateTempSubdirectory("medit-unitholding-").FullName;

    public void Dispose()
    {
        try { Directory.Delete(_modFolder, recursive: true); }
        catch (IOException) { /* scratch directory, best effort */ }
    }

    private SourceRepository Tracked()
    {
        var header = new TreeFile(HeaderPath, "{\"MasterReferences\": []}"u8.ToArray());
        SourceRepository.Track(
            _modFolder, SourcePreset.Edits, [header], new TrackProvenance(null, null, new Dictionary<string, string>()));
        return SourceRepository.Open(_modFolder, GameRelease.Fallout4)
            ?? throw new InvalidOperationException($"Expected '{_modFolder}' to already be tracked.");
    }

    // The header has no group folder and carries no FormKey in its file name, so every other
    // resolution branch answers null for it.
    [Fact]
    public void UnitHolding_AHeaderFormKey_IsItsOwnUndeletableDocument()
    {
        var repository = Tracked();
        var headerFormKey = PluginHeader.FormKeyFor(ModKey.FromFileName(PluginName));
        var identity = new RecordIdentity(headerFormKey, PluginHeader.RecordType, EditorId: null);

        var unit = repository.UnitHolding(Plugin, identity);

        Assert.NotNull(unit);
        Assert.False(unit.IsEmbedded);
        Assert.Equal(headerFormKey, unit.OwnerFormKey);
        Assert.Equal(PluginHeader.RecordType, unit.OwnerRecordType);
        // Filename-only, the header's root RecordData.json shares the name a container's document has.
        Assert.False(unit.IsDirectoryPerRecord);
        // From the same read as the facts, so nothing can move between them and the path a refusal names.
        Assert.Equal(HeaderPath, unit.RelativePath);
    }

    // An embedded type has no file of its own, so nothing is computed for it: either a document in the
    // tree carries it or no unit holds it at all.
    [Fact]
    public void UnitHolding_AnEmbeddedRecordNoDocumentCarries_AnswersNothing()
    {
        var repository = Tracked();

        var unit = repository.UnitHolding(Plugin, new RecordIdentity($"FFFFFF:{PluginName}", "PlacedObject", EditorId: null));

        Assert.Null(unit);
    }
}
