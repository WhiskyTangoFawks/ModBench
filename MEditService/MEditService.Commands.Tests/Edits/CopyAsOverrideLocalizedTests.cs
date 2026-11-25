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

public sealed class CopyAsOverrideLocalizedTests
{
    private const string EnglishName = "The Big Door";
    private const string FrenchName = "La Grande Porte";

    public sealed class LocalizedSourceCopy : TestInstance
    {
        private readonly PluginAddress _source;
        private readonly PluginAddress _destination;

        internal LocalizedSourceCopy(bool destinationLocalized, bool doorNamedInStringsLanguage = true)
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
                    new KeyValuePair<Language, string>(Language.French, FrenchName),
                ]),
            };
            var placedObject = new PlacedObject(sourceMod) { EditorID = "MainRef", Position = new P3Float(1f, 2f, 3f), Scale = 1f };
            cell.Persistent.Add(placedObject);
            sourceMod.AddInteriorCells(cell);
            (MainDoor, MainCell, MainRef) = (door.FormKey, cell.FormKey, placedObject.FormKey);
            _source = Add(sourceMod, "LocalizedMod", compiledPlugin: false);

            var destinationMod = new Fallout4Mod(ModKey.FromFileName("Destination.esp"), Fallout4Release.Fallout4)
            {
                UsingLocalization = destinationLocalized,
            };
            if (destinationLocalized) destinationMod.Doors.AddNew("OtherDoor").Name = new TranslatedString(Language.French, "Une Autre Porte");
            _destination = Add(destinationMod, "DestinationMod");
        }

        internal FormKey MainDoor { get; }
        internal FormKey MainCell { get; }
        internal FormKey MainRef { get; }

        internal CopyRecordResult CopyOverride(params FormKey[] records) =>
            CopyHandler.CopySync([.. records.Select(record => new RecordAt(_source, record.ToString()))], CopyMode.Override, [_destination], replace: false);

        internal void DeleteTheSourcesStringsFiles() => Directory.Delete(Path.Combine(ModFolderOf(_source), "Strings"), recursive: true);

        internal SourceDocument? InDestination(FormKey record) => SourceModTree.Document(ModFolderOf(_destination), _destination, record.ToString());
    }

    public static TheoryData<string, bool, Func<LocalizedSourceCopy, (FormKey Copied, FormKey Landed)>> Copies => new()
    {
        { "a record into a plugin that is not localized", false, copy => (copy.MainDoor, copy.MainDoor) },
        { "a child into a plugin that is not localized, its copied-in container", false, copy => (copy.MainRef, copy.MainCell) },
        { "a record into a localized plugin", true, copy => (copy.MainDoor, copy.MainDoor) },
    };

    [Theory]
    [MemberData(nameof(Copies))]
    public void CopyRecordAsOverride_FromALocalizedSource_LandsTheStringsLanguageValueAlone_UnlessTheDestinationIsLocalized(
        string _, bool destinationLocalized, Func<LocalizedSourceCopy, (FormKey Copied, FormKey Landed)> records)
    {
        using var copy = new LocalizedSourceCopy(destinationLocalized);
        var (copied, landed) = records(copy);

        copy.CopyOverride(copied).OnlyLanded();

        var body = copy.InDestination(landed).Require().Body;
        Assert.Equal(
            (true, destinationLocalized, destinationLocalized),
            (body.Contains(FrenchName, StringComparison.Ordinal), body.Contains(EnglishName, StringComparison.Ordinal), body.Contains("\"Values\"", StringComparison.Ordinal)));
    }

    [Fact]
    public void CopyRecordAsOverride_OfAStringWithNoTextInTheStringsLanguage_RefusesNamingTheFieldAndWritesNothing()
    {
        using var copy = new LocalizedSourceCopy(destinationLocalized: false, doorNamedInStringsLanguage: false);

        var refused = Assert.Single(copy.CopyOverride(copy.MainCell, copy.MainDoor).Refused);

        Assert.Equal(RecordEditRefusal.NoTextInStringsLanguage, refused.Refusal);
        Assert.Contains("Name", refused.Message, StringComparison.Ordinal);
        Assert.Contains("French", refused.Message, StringComparison.Ordinal);
        Assert.Null(copy.InDestination(copy.MainDoor));
    }

    [Fact]
    public void CopyRecordAsOverride_FromASourceMissingItsStringsFiles_RefusesNamingTheMissingFileAndWritesNothing()
    {
        using var copy = new LocalizedSourceCopy(destinationLocalized: false);
        copy.DeleteTheSourcesStringsFiles();

        var refused = Assert.Single(copy.CopyOverride(copy.MainDoor).Refused);

        Assert.Contains("Localized.esm", refused.Message, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("strings file", refused.Message, StringComparison.Ordinal);
        Assert.Null(copy.InDestination(copy.MainDoor));
    }
}
