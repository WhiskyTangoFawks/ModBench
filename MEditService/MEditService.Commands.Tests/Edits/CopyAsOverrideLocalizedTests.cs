using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Strings;
using Noggog;

namespace MEditService.Commands.Tests.Edits;

public abstract class LocalizedSourceCopyScenario : TestInstance
{
    protected const string EnglishName = "The Big Door";
    protected const string FrenchName = "La Grande Porte";

    private readonly PluginAddress _source;
    private readonly PluginAddress _destination;
    private readonly FormKey _door;
    private readonly FormKey _cell;
    private readonly FormKey _placedObject;

    protected LocalizedSourceCopyScenario(bool destinationLocalized, bool doorNamedInStringsLanguage = true, bool cellNamedInStringsLanguage = true)
        : base(stringsLanguage: Language.French)
    {
        var sourceMod = new Fallout4Mod(ModKey.FromFileName("Localized.esm"), Fallout4Release.Fallout4) { UsingLocalization = true };
        var door = sourceMod.Doors.AddNew("MainDoor");
        door.Name = new TranslatedString(Language.English, [
            new KeyValuePair<Language, string>(Language.English, EnglishName),
            new KeyValuePair<Language, string>(doorNamedInStringsLanguage ? Language.French : Language.German, doorNamedInStringsLanguage ? FrenchName : "Das Grosse Tor"),
        ]);
        var cell = new Cell(sourceMod)
        {
            EditorID = "MainCell",
            Name = new TranslatedString(Language.English, [
                new KeyValuePair<Language, string>(Language.English, EnglishName),
                new KeyValuePair<Language, string>(cellNamedInStringsLanguage ? Language.French : Language.German, FrenchName),
            ]),
        };
        var placedObject = new PlacedObject(sourceMod) { EditorID = "MainRef", Position = new P3Float(1f, 2f, 3f), Scale = 1f };
        cell.Persistent.Add(placedObject);
        sourceMod.AddInteriorCells(cell);
        (_door, _cell, _placedObject) = (door.FormKey, cell.FormKey, placedObject.FormKey);
        _source = Add(sourceMod, "LocalizedMod", compiledPlugin: false);

        var destinationMod = new Fallout4Mod(ModKey.FromFileName("Destination.esp"), Fallout4Release.Fallout4)
        {
            UsingLocalization = destinationLocalized,
        };
        if (destinationLocalized) destinationMod.Doors.AddNew("OtherDoor").Name = new TranslatedString(Language.French, "Une Autre Porte");
        _destination = Add(destinationMod, "DestinationMod");
    }

    protected async Task<string> CopiedDoorBody()
    {
        var body = CopiedBody(_door, _door);
        await CompileHandler.CompileLandedAsync(_destination);
        return body;
    }

    protected async Task<string> CopiedCellBody()
    {
        var body = CopiedBody(_placedObject, _cell);
        await CompileHandler.CompileLandedAsync(_destination);
        return body;
    }

    protected CopyRecordResult CopyCellThenDoor() =>
        CopyHandler.CopySync([new RecordAt(_source, _cell.ToString()), new RecordAt(_source, _door.ToString())], CopyMode.Override, [_destination], replace: false);

    protected CopyRecordResult CopyPlacedObject() =>
        CopyHandler.CopySync([new RecordAt(_source, _placedObject.ToString())], CopyMode.Override, [_destination], replace: false);

    protected SourceDocument? DoorInDestination() => SourceModTree.Document(ModFolderOf(_destination), _destination, _door.ToString());

    protected SourceDocument? CellInDestination() => SourceModTree.Document(ModFolderOf(_destination), _destination, _cell.ToString());

    private string CopiedBody(FormKey copied, FormKey landed)
    {
        CopyHandler.CopySync([new RecordAt(_source, copied.ToString())], CopyMode.Override, [_destination], replace: false).OnlyLanded();
        return SourceModTree.Document(ModFolderOf(_destination), _destination, landed.ToString()).Require().Body;
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
    public void CopyRecordAsOverride_OfAStringWithNoTextInTheStringsLanguage_RefusesNamingTheFieldAndWritesNothing()
    {
        var result = CopyCellThenDoor();

        var refused = Assert.Single(result.Refused);
        Assert.Equal(RecordEditRefusal.NoTextInStringsLanguage, refused.Refusal);
        Assert.Contains("Name", refused.Message, StringComparison.Ordinal);
        Assert.Contains("French", refused.Message, StringComparison.Ordinal);
        Assert.Null(DoorInDestination());
    }

    [Fact]
    public void CopyRecordAsOverride_OfASelectionWithOneStringWithNoTextInTheStringsLanguage_LandsTheOthers()
    {
        var result = CopyCellThenDoor();

        Assert.Single(result.Applied);
        Assert.NotNull(CellInDestination());
    }
}

public sealed class CopyAsOverrideOfAChildWithoutStringsLanguageTextInItsContainerTests()
    : LocalizedSourceCopyScenario(destinationLocalized: false, cellNamedInStringsLanguage: false)
{
    [Fact]
    public void CopyRecordAsOverride_OfAChildWhoseContainerHasAStringWithNoTextInTheStringsLanguage_RefusesTheChildAndWritesNothing()
    {
        var result = CopyPlacedObject();

        Assert.Equal(RecordEditRefusal.NoTextInStringsLanguage, Assert.Single(result.Refused).Refusal);
        Assert.Null(CellInDestination());
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
