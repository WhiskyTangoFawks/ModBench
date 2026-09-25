using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Strings;

namespace MEditService.Commands.Tests.Edits;

/// <summary>Its own fixture rather than <see cref="CopyFixture"/>: the source must be localized, the
/// shape of the game's own masters, and none of that fixture's records carry a translated string.
/// </summary>
public sealed class CopyRecordAsOverrideLocalizedTests : IDisposable
{
    private const string SourcePluginName = "Localized.esm";
    private const string SourceOrigin = "LocalizedMod";
    private const string DestinationPluginName = "Destination.esp";
    private const string DestinationOrigin = "DestinationMod";
    private const string DoorName = "The Big Door";

    private readonly string _sourceModFolder = Directory.CreateTempSubdirectory("medit-copy-localized-source-").FullName;
    private readonly string _destinationModFolder = Directory.CreateTempSubdirectory("medit-copy-localized-dest-").FullName;
    private readonly string _gameDir = Directory.CreateTempSubdirectory("medit-copy-localized-game-").FullName;
    private readonly FormKey _door;
    private readonly CopyRecordAsOverrideHandler _handler;

    public CopyRecordAsOverrideLocalizedTests()
    {
        var sourceMod = new Fallout4Mod(ModKey.FromFileName(SourcePluginName), Fallout4Release.Fallout4);
        var door = sourceMod.Doors.AddNew("MainDoor");
        door.Name = new TranslatedString(Language.English, DoorName);
        sourceMod.UsingLocalization = true;
        var sourcePath = Path.Combine(_sourceModFolder, SourcePluginName);
        sourceMod.WriteToBinary(sourcePath);
        _door = door.FormKey;

        var destinationMod = new Fallout4Mod(ModKey.FromFileName(DestinationPluginName), Fallout4Release.Fallout4);
        var destinationPath = Path.Combine(_destinationModFolder, DestinationPluginName);
        destinationMod.WriteToBinary(destinationPath);

        var loadOrder = new LoadOrderSnapshot(
            _gameDir, _gameDir, GameRelease.Fallout4,
            SnapshotPlugins.Of(
            [
                new LoadOrderEntry(SourcePluginName, sourcePath, SourceOrigin, Slot: 0, Enabled: true, Winning: true),
                new LoadOrderEntry(DestinationPluginName, destinationPath, DestinationOrigin, Slot: 1, Enabled: true, Winning: true),
            ]));
        new TrackService(NullLogger<TrackService>.Instance, TestAdapters.Mutagen())
            .TrackModAsync(loadOrder, DestinationOrigin, SourcePreset.Edits).GetAwaiter().GetResult();

        var holder = new LoadOrderHolder();
        holder.Apply(loadOrder);
        _handler = TestEditService.CopyAsOverrideHandler(holder);
    }

    public void Dispose()
    {
        Directory.Delete(_sourceModFolder, recursive: true);
        Directory.Delete(_destinationModFolder, recursive: true);
        Directory.Delete(_gameDir, recursive: true);
    }

    [Fact]
    public void CopyRecordAsOverride_FromAnUntrackedLocalizedSource_CarriesItsTranslatedStrings()
    {
        var destination = new PluginAddress(DestinationPluginName, DestinationOrigin);

        var result = _handler.CopyRecordAsOverride(
            new PluginAddress(SourcePluginName, SourceOrigin), _door.ToString(), destination);

        Assert.True(result.Applied, result.Message);
        var document = TrackedTree.Document(_destinationModFolder, destination, _door.ToString());
        Assert.NotNull(document);
        Assert.Contains(DoorName, document.Body, StringComparison.Ordinal);
    }
}
