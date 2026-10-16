using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Noggog;
using Mutagen.Bethesda.Strings;

namespace MEditService.Commands.Tests.Edits;

public abstract class LocalizedSourceCopyScenario : IDisposable
{
    protected const string SourcePluginName = "Localized.esm";
    protected const string SourceOrigin = "LocalizedMod";
    protected const string DestinationPluginName = "Destination.esp";
    protected const string DestinationOrigin = "DestinationMod";
    protected const string EnglishName = "The Big Door";
    protected const string FrenchName = "La Grande Porte";

    private readonly ScratchDirectory _sourceModFolder = new("medit-copy-localized-source-");
    private readonly ScratchDirectory _destinationModFolder = new("medit-copy-localized-dest-");
    private readonly ScratchDirectory _gameDir = new("medit-copy-localized-game-");
    private readonly FormKey _door;
    private readonly FormKey _cell;
    private readonly FormKey _placedObject;
    private readonly LoadOrderSnapshot _loadOrder;
    private readonly CopyRecordChangesHandler _handler;

    protected LocalizedSourceCopyScenario(bool destinationLocalized, bool doorNamedInStringsLanguage = true)
    {
        var sourceMod = new Fallout4Mod(ModKey.FromFileName(SourcePluginName), Fallout4Release.Fallout4);
        var door = sourceMod.Doors.AddNew("MainDoor");
        door.Name = new TranslatedString(Language.English, [
            new KeyValuePair<Language, string>(Language.English, EnglishName),
            new KeyValuePair<Language, string>(doorNamedInStringsLanguage ? Language.French : Language.German, doorNamedInStringsLanguage ? FrenchName : "Das Grosse Tor"),
        ]);
        sourceMod.UsingLocalization = true;
        var sourcePath = Path.Combine(_sourceModFolder, SourcePluginName);
        _door = door.FormKey;

        var cell = new Cell(sourceMod)
        {
            EditorID = "MainCell",
            Name = new TranslatedString(Language.English, [
                new KeyValuePair<Language, string>(Language.English, EnglishName),
                new KeyValuePair<Language, string>(Language.French, FrenchName),
            ]),
        };
        var placedObject = new PlacedObject(sourceMod) { EditorID = "MainRef", Position = new P3Float(1f, 2f, 3f), Scale = 1f };
        cell.Persistent.Add(placedObject);
        var subBlock = new CellSubBlock { BlockNumber = 0, GroupType = GroupTypeEnum.InteriorCellSubBlock };
        subBlock.Cells.Add(cell);
        var block = new CellBlock { BlockNumber = 0, GroupType = GroupTypeEnum.InteriorCellBlock };
        block.SubBlocks.Add(subBlock);
        sourceMod.Cells.Records.Add(block);
        (_cell, _placedObject) = (cell.FormKey, placedObject.FormKey);
        sourceMod.WriteToBinary(sourcePath);

        var destinationMod = new Fallout4Mod(ModKey.FromFileName(DestinationPluginName), Fallout4Release.Fallout4)
        {
            UsingLocalization = destinationLocalized,
        };
        if (destinationLocalized) destinationMod.Doors.AddNew("OtherDoor").Name = new TranslatedString(Language.French, "Une Autre Porte");
        var destinationPath = Path.Combine(_destinationModFolder, DestinationPluginName);
        destinationMod.WriteToBinary(destinationPath);

        _loadOrder = SnapshotPlugins.Snapshot(
            _gameDir, _gameDir, GameRelease.Fallout4,

            [
                new LoadOrderEntry(SourcePluginName, sourcePath, SourceOrigin, Line: 0, Enabled: true, Winning: true),
                new LoadOrderEntry(DestinationPluginName, destinationPath, DestinationOrigin, Line: 1, Enabled: true, Winning: true),
            ],
            stringsLanguage: Language.French);
        InitEveryPluginOf.ModAsync(_loadOrder, DestinationOrigin).GetAwaiter().GetResult();

        var holder = new LoadOrderHolder();
        holder.Apply(_loadOrder);
        _handler = TestEditService.CopyHandler(holder);
    }

    public void Dispose()
    {
        _sourceModFolder.Dispose();
        _destinationModFolder.Dispose();
        _gameDir.Dispose();
    }

    protected async Task<string> CopiedDoorBody()
    {
        var body = CopiedBody(_door, _door);
        await CompileServices.Over(_loadOrder).CompileLandedAsync(Destination);
        return body;
    }

    protected async Task<string> CopiedCellBody()
    {
        var body = CopiedBody(_placedObject, _cell);
        await CompileServices.Over(_loadOrder).CompileLandedAsync(Destination);
        return body;
    }

    protected string CopiedUncompiledDoorBody() => CopiedBody(_door, _door);

    protected Task<SelectionResult<PluginAddress, CompileRefusal, IReadOnlyList<CompileDiagnostic>>> CompileDestination() => CompileServices.Over(_loadOrder).CompileAsync([Destination]);

    private static PluginAddress Destination => new(DestinationPluginName, DestinationOrigin);

    private string CopiedBody(FormKey copied, FormKey landed)
    {
        var destination = new PluginAddress(DestinationPluginName, DestinationOrigin);

        var result = _handler.CopySync([new RecordAt(new PluginAddress(SourcePluginName, SourceOrigin), copied.ToString())], CopyMode.Override, [destination], replace: false);

        result.OnlyLanded();
        var document = SourceModTree.Document(_destinationModFolder, destination, landed.ToString());
        Assert.NotNull(document);
        return document.Body;
    }
}

public sealed class CopyAsOverrideLocalizedTests() : LocalizedSourceCopyScenario(destinationLocalized: false)
{
    [Fact]
    public async Task CopyRecordAsOverride_FromALocalizedSourceIntoAPluginThatIsNot_WritesTheStringsLanguageValueAndCompiles()
    {
        var body = await CopiedDoorBody();

        Assert.Contains(FrenchName, body, StringComparison.Ordinal);
        Assert.DoesNotContain(EnglishName, body, StringComparison.Ordinal);
        Assert.DoesNotContain("\"Values\"", body, StringComparison.Ordinal);
    }

    [Fact]
    public async Task CopyRecordAsOverride_OfAChildIntoAPluginThatIsNot_WritesTheCopiedInContainersStringsLanguageValue()
    {
        var body = await CopiedCellBody();

        Assert.Contains(FrenchName, body, StringComparison.Ordinal);
        Assert.DoesNotContain("\"Values\"", body, StringComparison.Ordinal);
    }
}

public sealed class CopyAsOverrideWithoutStringsLanguageTextTests() : LocalizedSourceCopyScenario(destinationLocalized: false, doorNamedInStringsLanguage: false)
{
    [Fact]
    public async Task CopyRecordAsOverride_OfAStringWithNoTextInTheStringsLanguage_LeavesItAndTheCompileRefuses()
    {
        var body = CopiedUncompiledDoorBody();

        var answer = await CompileDestination();

        Assert.Contains("\"Values\"", body, StringComparison.Ordinal);
        Assert.Equal(CompileRefusal.SourceValueDropped, Assert.Single(answer.Refused).Refusal);
    }
}

public sealed class CopyAsOverrideIntoLocalizedTests() : LocalizedSourceCopyScenario(destinationLocalized: true)
{
    [Fact]
    public async Task CopyRecordAsOverride_FromALocalizedSourceIntoALocalizedPlugin_KeepsEveryLanguage()
    {
        var body = await CopiedDoorBody();

        Assert.Contains(FrenchName, body, StringComparison.Ordinal);
        Assert.Contains(EnglishName, body, StringComparison.Ordinal);
    }
}
