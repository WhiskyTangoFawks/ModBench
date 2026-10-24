using System.Text;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.PluginAdapter.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Strings;

namespace MEditService.PluginAdapter.Tests.PluginAdapter;

public sealed class GameDataStringsTests : IDisposable
{
    private const string PluginName = "Update.esm";
    private const string ModName = "Cleaned Masters";
    private const string DoorName = "The Big Door";

    private static readonly IPluginAdapter Adapter = TestAdapters.Mutagen();

    private readonly ScratchDirectory _root = new("medit-game-data-strings-");
    private readonly string _modFolder;
    private readonly string _dataFolder;
    private readonly string _pluginPath;

    public GameDataStringsTests()
    {
        _modFolder = Directory.CreateDirectory(Path.Combine(_root, "mods", ModName)).FullName;
        _dataFolder = Directory.CreateDirectory(Path.Combine(_root, "Game", "Data")).FullName;
        _pluginPath = Path.Combine(_modFolder, PluginName);
        LocalizedDoorPlugin.Write(_pluginPath, DoorName);
    }

    public void Dispose() => _root.Dispose();

    private string[] _archivesTheGameLoads = [];

    private string[] _stringsFilesTheGameReads = [];

    private LoadOrderSnapshot LoadOrder =>
        new(_dataFolder, null, GameRelease.SkyrimSE, [Plugin, GameCopy], [], [GameCopy.Key], [.. _archivesTheGameLoads.Select(HandedStrings.Stamped)],
            [.. _stringsFilesTheGameReads.Select(HandedStrings.Stamped)], [], Language.English);

    private RegisteredPlugin Plugin => new(
        PluginName, ModName, _pluginPath, new PluginProvider.FromMod(ModName, _modFolder, _modFolder), new PluginLine(0, NamesIt: true),
        HandedStrings.Of(_pluginPath));

    private RegisteredPlugin GameCopy => new(
        PluginName, PluginOrigin.DataDirectory, Path.Combine(_dataFolder, PluginName), PluginProvider.Game, Line: null,
        HandedStrings.Of(Path.Combine(_dataFolder, PluginName)));

    private void MoveStringsIntoGameData(string archiveName)
    {
        LocalizedDoorPlugin.PackStrings(_pluginPath, Path.Combine(_dataFolder, archiveName));
        TheGameLoads(archiveName);
    }

    private RepositoriesLib.Answer<IPluginDocuments, PluginFailure> OpenDocuments(string pluginPath, PluginStrings? handed = null) =>
        Adapter.OpenDocuments(
            new ModPath(ModKey.FromFileName(PluginName), pluginPath), LoadOrder,
            SharedSchemaReflector.Instance.GetSchemas(GameRelease.SkyrimSE),
            handed ?? HandedStrings.Of(pluginPath));

    [Fact]
    public void ThePlaceOfAPluginsStringsInOneOfTwoLoadedArchivesIsThatArchive()
    {
        var other = Path.Combine(Directory.CreateDirectory(Path.Combine(_root, "Other")).FullName, "Other.esm");
        LocalizedDoorPlugin.Write(other, "The Other Door");
        LocalizedDoorPlugin.PackStrings(other, Path.Combine(_dataFolder, "Other.bsa"));
        LocalizedDoorPlugin.PackStrings(_pluginPath, Path.Combine(_dataFolder, "Update.bsa"));
        TheGameLoads("Update.bsa", "Other.bsa");

        Assert.Equal([Path.Combine(_dataFolder, "Update.bsa")], StringsPlacesOf(Plugin));
    }

    [Fact]
    public void AReadSaysWhetherAPluginIsLocalized()
    {
        var notLocalized = Path.Combine(Directory.CreateDirectory(Path.Combine(_root, "Plain")).FullName, PluginName);
        LocalizedDoorPlugin.WriteNameInPlugin(notLocalized, DoorName);

        Assert.Equal([true, false], [IsLocalized(_pluginPath), IsLocalized(notLocalized)]);
    }

    private bool IsLocalized(string pluginPath) =>
        Adapter.ReadContent(new ModPath(ModKey.FromFileName(PluginName), pluginPath), LoadOrder, HandedStrings.Of(pluginPath)).Answered().Content.IsLocalized;

    [Theory]
    [InlineData("1", 1)]
    [InlineData("2", 0)]
    public void AnArchiveRewrittenWithAnotherPluginsStrings_KeepsItsListingOnlyWhileItsHandedStampIsUnchanged(string stampAfter, int placesAfter)
    {
        var places = PlacesBeforeAndAfterAnotherPluginsStringsReplaceTheArchives(stampAfter);

        Assert.Equal([1, placesAfter], places.Select(listed => listed.Count));
        Assert.All(places.SelectMany(listed => listed), place => Assert.Equal(UpdateArchive, place));
    }

    private string UpdateArchive => Path.Combine(_dataFolder, "Update.bsa");

    private IReadOnlyList<string>[] PlacesBeforeAndAfterAnotherPluginsStringsReplaceTheArchives(string stampAfter)
    {
        LocalizedDoorPlugin.PackStrings(_pluginPath, UpdateArchive);
        var before = StringsPlacesOf(Plugin, TheGameLoadingOnly(new StampedFile(UpdateArchive, "1")));
        var other = Path.Combine(Directory.CreateDirectory(Path.Combine(_root, "Other")).FullName, "Other.esm");
        LocalizedDoorPlugin.Write(other, "The Other Door");
        LocalizedDoorPlugin.PackStrings(other, UpdateArchive);
        return [before, StringsPlacesOf(Plugin, TheGameLoadingOnly(new StampedFile(UpdateArchive, stampAfter)))];
    }

    private LoadOrderSnapshot TheGameLoadingOnly(StampedFile archive) =>
        new(_dataFolder, null, GameRelease.SkyrimSE, [Plugin, GameCopy], [], [GameCopy.Key], [archive], [], [], Language.English);

    private IReadOnlyList<string> StringsPlacesOf(RegisteredPlugin plugin) => StringsPlacesOf(plugin, LoadOrder);

    private static IReadOnlyList<string> StringsPlacesOf(RegisteredPlugin plugin, LoadOrderSnapshot loadOrder) =>
        Adapter.StringsPlacesOf(new ModPath(ModKey.FromFileName(PluginName), plugin.Path), loadOrder, plugin.Strings).Answered();

    [Fact]
    public void OpenDocuments_TwoCopiesOfAPluginEachWithItsOwnStrings_EachReadsItsOwn()
    {
        var (overridden, loadOrder) = AnOverriddenCopy("The Overridden Door");

        Assert.Equal(
            [true, true],
            [DoorOf(Plugin, loadOrder).Contains(DoorName, StringComparison.Ordinal), DoorOf(overridden, loadOrder).Contains("The Overridden Door", StringComparison.Ordinal)]);
    }

    [Fact]
    public void ReadContent_ACopyTheGamesListsDoNotAnswerForWithNoStringsOfItsOwn_NamesThemMissing()
    {
        var (overridden, loadOrder) = AnOverriddenCopy("The Overridden Door");
        Directory.Delete(LocalizedDoorPlugin.LooseStrings(overridden.Path), recursive: true);

        var (content, _) = Adapter.ReadContent(new ModPath(ModKey.FromFileName(PluginName), overridden.Path), loadOrder, PluginStrings.None).Answered();

        Assert.Equal(["Update_English.STRINGS", "Update_English.ILSTRINGS", "Update_English.DLSTRINGS"], content.MissingStringsFiles);
    }

    private (RegisteredPlugin Overridden, LoadOrderSnapshot LoadOrder) AnOverriddenCopy(string doorName)
    {
        var folder = Directory.CreateDirectory(Path.Combine(_root, "mods", "Overridden")).FullName;
        var path = Path.Combine(folder, PluginName);
        LocalizedDoorPlugin.Write(path, doorName);
        var overridden = new RegisteredPlugin(
            PluginName, "Overridden", path, new PluginProvider.FromMod("Overridden", folder, folder), new PluginLine(0, NamesIt: false), HandedStrings.Of(path));
        return (overridden, new LoadOrderSnapshot(_dataFolder, null, GameRelease.SkyrimSE, [Plugin, overridden], [Plugin.Key], [], [], Plugin.Strings.StringsFiles, [], Language.English));
    }

    private static string DoorOf(RegisteredPlugin copy, LoadOrderSnapshot loadOrder)
    {
        using var documents = Adapter.OpenDocuments(
            new ModPath(ModKey.FromFileName(PluginName), copy.Path), loadOrder, SharedSchemaReflector.Instance.GetSchemas(GameRelease.SkyrimSE),
            copy.Strings).Answered();
        return Assert.Single(documents.Records).Text;
    }

    [Fact]
    public void OpenDocuments_StringsFilesHandedFromAnotherFolder_AreTheOnesRead()
    {
        var elsewhere = Path.Combine(Directory.CreateDirectory(Path.Combine(_root, "Elsewhere")).FullName, PluginName);
        LocalizedDoorPlugin.Write(elsewhere, "La Grande Porte");

        using var documents = OpenDocuments(_pluginPath, HandedStrings.Of(elsewhere)).Answered();

        Assert.Contains("La Grande Porte", documents.Records.Single().Text, StringComparison.Ordinal);
    }

    [Fact]
    public void OpenDocuments_AStringsFileBesideThePluginThatIsNotHanded_IsNotRead()
    {
        using var documents = OpenDocuments(_pluginPath, PluginStrings.None).Answered();

        Assert.DoesNotContain(DoorName, documents.Records.Single().Text, StringComparison.Ordinal);
    }

    [Fact]
    public void ReadContent_ALocalizedPluginWithOneOfItsStringsFilesHanded_NamesTheOthersMissing()
    {
        var handed = new PluginStrings([], [HandedStrings.Stamped(Path.Combine(LocalizedDoorPlugin.LooseStrings(_pluginPath), "Update_English.STRINGS"))]);

        var (content, _) = Adapter.ReadContent(new ModPath(ModKey.FromFileName(PluginName), _pluginPath), LoadOrder, handed).Answered();

        Assert.Equal(["Update_English.ILSTRINGS", "Update_English.DLSTRINGS"], content.MissingStringsFiles);
    }

    [Fact]
    public async Task ReadSourceOf_APluginWhoseStringsAreInAnArchiveForItTheGameLoads_ReadsThemFromThere()
    {
        MoveStringsIntoGameData("Update.bsa");

        var source = (await Adapter.ReadSourceOfAsync(Plugin, LoadOrder)).Answered();

        Assert.Contains(source.Files, file => Encoding.UTF8.GetString(file.Content).Contains(DoorName, StringComparison.Ordinal));
    }

    [Fact]
    public void OpenDocuments_APluginWhoseStringsAreInAnArchiveForItTheGameLoads_ReadsItsNamesFromThere()
    {
        MoveStringsIntoGameData("Update.bsa");

        using var documents = OpenDocuments(_pluginPath).Answered();

        Assert.Contains(DoorName, documents.Records.Single().Text, StringComparison.Ordinal);
    }

    [Fact]
    public void OpenDocuments_APluginWhoseStringsAreBesideItAndInAnArchiveTheGameLoads_ReadsTheOnesTheGameLoads()
    {
        MoveStringsIntoGameData("Update.bsa");
        LocalizedDoorPlugin.Write(_pluginPath, "The Mod's Door");

        using var documents = OpenDocuments(_pluginPath).Answered();

        Assert.Contains(DoorName, documents.Records.Single().Text, StringComparison.Ordinal);
    }

    [Fact]
    public void OpenDocuments_APluginWhoseStringsAreLooseBesideItAndLooseInATranslationTheGameReads_ReadsTheTranslation()
    {
        var copyInTranslation = Path.Combine(Directory.CreateDirectory(Path.Combine(_root, "mods", "Translation")).FullName, PluginName);
        LocalizedDoorPlugin.Write(copyInTranslation, "La Grande Porte");
        File.Delete(copyInTranslation);
        _stringsFilesTheGameReads = [.. Directory.EnumerateFiles(LocalizedDoorPlugin.LooseStrings(copyInTranslation))];

        using var documents = OpenDocuments(_pluginPath).Answered();

        Assert.Contains("La Grande Porte", documents.Records.Single().Text, StringComparison.Ordinal);
    }

    [Fact]
    public void OpenDocuments_APluginWhoseStringsAreInAnArchiveBesideItAndLooseInAnotherModTheGameReads_ReadsTheLooseOnes()
    {
        LocalizedDoorPlugin.PackStrings(_pluginPath, Path.Combine(_modFolder, "Update.bsa"));
        var copyInTranslation = Path.Combine(Directory.CreateDirectory(Path.Combine(_root, "mods", "Translation")).FullName, PluginName);
        LocalizedDoorPlugin.Write(copyInTranslation, "The Loose Door");
        File.Delete(copyInTranslation);
        _stringsFilesTheGameReads = [.. Directory.EnumerateFiles(LocalizedDoorPlugin.LooseStrings(copyInTranslation))];

        using var documents = OpenDocuments(_pluginPath).Answered();

        Assert.Contains("The Loose Door", documents.Records.Single().Text, StringComparison.Ordinal);
    }

    [Fact]
    public void OpenDocuments_AnArchiveNamedForThePluginInTheGameDataFolderThatTheGameDoesNotLoad_IsNotRead()
    {
        LocalizedDoorPlugin.PackStrings(_pluginPath, Path.Combine(_dataFolder, "Update.bsa"));

        using var documents = OpenDocuments(_pluginPath).Answered();

        Assert.DoesNotContain(DoorName, documents.Records.Single().Text, StringComparison.Ordinal);
    }

    [Fact]
    public void OpenDocuments_ALooseStringsFileTheGameReadsForAnotherPlugin_IsNotRead()
    {
        var other = Path.Combine(Directory.CreateDirectory(Path.Combine(_root, "mods", "Other")).FullName, "Other.esm");
        LocalizedDoorPlugin.Write(other, "Another Door");
        Directory.Delete(LocalizedDoorPlugin.LooseStrings(_pluginPath), recursive: true);
        _stringsFilesTheGameReads = [.. Directory.EnumerateFiles(LocalizedDoorPlugin.LooseStrings(other))];

        using var documents = OpenDocuments(_pluginPath).Answered();

        Assert.DoesNotContain("Another Door", documents.Records.Single().Text, StringComparison.Ordinal);
    }

    [Fact]
    public void OpenRecordLookup_APluginWhoseStringsAreInAnArchiveForItTheGameLoads_ReadsItsNamesFromThere()
    {
        MoveStringsIntoGameData("Update.bsa");

        using var records = Adapter.OpenRecordLookup(Plugin, LoadOrder, SharedSchemaReflector.Instance.GetSchemas(GameRelease.SkyrimSE)).Answered();

        Assert.Contains(DoorName, records.TextOf("000800:Update.esm").Answered(), StringComparison.Ordinal);
    }

    [Fact]
    public void OpenDocuments_AGameMasterWhoseStringsAreOnlyInAnArchiveNamedForNoPluginThatTheGameLoads_ReadsItsNames()
    {
        var masterPath = Path.Combine(_dataFolder, PluginName);
        LocalizedDoorPlugin.Write(masterPath, DoorName);
        LocalizedDoorPlugin.PackStrings(masterPath, Path.Combine(_dataFolder, "Skyrim - Interface.bsa"));
        TheGameLoads("Skyrim - Interface.bsa");

        using var documents = OpenDocuments(masterPath).Answered();

        Assert.Contains(DoorName, documents.Records.Single().Text, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ReadSourceOf_AModsCopyOfAGameMasterWhoseStringsAreOnlyInAnArchiveTheGameLoads_TracksItsNames()
    {
        LocalizedDoorPlugin.PackStrings(_pluginPath, Path.Combine(_dataFolder, "Skyrim - Interface.bsa"));
        TheGameLoads("Skyrim - Interface.bsa");

        var source = (await Adapter.ReadSourceOfAsync(Plugin, LoadOrder)).Answered();

        Assert.Contains(source.Files, file => Encoding.UTF8.GetString(file.Content).Contains(DoorName, StringComparison.Ordinal));
    }

    [Fact]
    public void OpenDocuments_TwoArchivesTheGameLoadsHoldingAPluginsStrings_ReadsTheOneItLoadsLast()
    {
        LocalizedDoorPlugin.Write(_pluginPath, "The Old Door");
        LocalizedDoorPlugin.PackStrings(_pluginPath, Path.Combine(_dataFolder, "Skyrim - Interface.bsa"));
        LocalizedDoorPlugin.Write(_pluginPath, DoorName);
        LocalizedDoorPlugin.PackStrings(_pluginPath, Path.Combine(_dataFolder, "Skyrim - Patch.bsa"));
        TheGameLoads("Skyrim - Interface.bsa", "Skyrim - Patch.bsa");

        using var documents = OpenDocuments(_pluginPath).Answered();

        Assert.Contains(DoorName, documents.Records.Single().Text, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ReadSourceOf_AGameThatReadsOnlyOneOfAPluginsStringsFiles_TakesNoneOfTheRestFromBesideThePlugin()
    {
        var copyInTranslation = Path.Combine(Directory.CreateDirectory(Path.Combine(_root, "mods", "Translation")).FullName, PluginName);
        LocalizedDoorPlugin.Write(copyInTranslation, "La Grande Porte");
        File.Delete(copyInTranslation);
        _stringsFilesTheGameReads = [Path.Combine(LocalizedDoorPlugin.LooseStrings(copyInTranslation), "Update_English.STRINGS")];

        var source = await Adapter.ReadSourceOfAsync(Plugin, LoadOrder);

        Assert.IsType<PluginFailure.MissingStrings>(source.Failure());
    }

    [Fact]
    public void OpenDocuments_APluginWithAnotherLanguagesStringsBesideItAndItsEnglishInTheGame_ReadsTheEnglish()
    {
        MoveStringsIntoGameData("Update.bsa");
        WriteOnlyFrenchStringsBesideThePlugin();

        using var documents = OpenDocuments(_pluginPath).Answered();

        Assert.Contains(DoorName, documents.Records.Single().Text, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ReadSourceOf_APluginWithAnotherLanguagesStringsBesideItAndItsEnglishInTheGame_TracksIt()
    {
        MoveStringsIntoGameData("Update.bsa");
        WriteOnlyFrenchStringsBesideThePlugin();

        var source = (await Adapter.ReadSourceOfAsync(Plugin, LoadOrder)).Answered();

        Assert.Contains(source.Files, file => Encoding.UTF8.GetString(file.Content).Contains(DoorName, StringComparison.Ordinal));
    }

    [Fact]
    public async Task ReadSourceOf_APluginsStringsInAnArchiveOrLoose_GiveItsLanguagesInOneOrder()
    {
        LocalizedDoorPlugin.WriteNamedIn(_pluginPath, (Language.English, DoorName), (Language.French, "La Grande Porte"), (Language.German, "Das Große Tor"));
        var looseStrings = Directory.EnumerateFiles(LocalizedDoorPlugin.LooseStrings(_pluginPath)).ToList();
        var archive = Path.Combine(_modFolder, "Update.bsa");
        var loose = await DoorSource();
        StringsArchive.Pack(looseStrings.Order(StringComparer.Ordinal), archive);
        Directory.Delete(LocalizedDoorPlugin.LooseStrings(_pluginPath), recursive: true);
        var packedInOrder = await DoorSource();
        LocalizedDoorPlugin.WriteNamedIn(_pluginPath, (Language.English, DoorName), (Language.French, "La Grande Porte"), (Language.German, "Das Große Tor"));
        StringsArchive.Pack(looseStrings.OrderDescending(StringComparer.Ordinal), archive);
        Directory.Delete(LocalizedDoorPlugin.LooseStrings(_pluginPath), recursive: true);

        Assert.Equal([loose, loose], [packedInOrder, await DoorSource()]);
    }

    [Fact]
    public void OpenDocuments_ALocalizedPluginWhoseArchiveIsCorrupt_FailsNamingTheArchive()
    {
        Directory.Delete(LocalizedDoorPlugin.LooseStrings(_pluginPath), recursive: true);
        File.WriteAllText(Path.Combine(_dataFolder, "Update.bsa"), "not an archive");
        TheGameLoads("Update.bsa");

        Assert.False(OpenDocuments(_pluginPath).Holds(out _, out var failure));
        Assert.StartsWith($"its strings archive '{Path.Combine(_dataFolder, "Update.bsa")}' could not be read", failure.Reason, StringComparison.Ordinal);
    }

    [Fact]
    public void OpenDocuments_ACorruptArchiveLoadedBeforeTheOneHoldingAPluginsStrings_IsNeverOpened()
    {
        LocalizedDoorPlugin.PackStrings(_pluginPath, Path.Combine(_dataFolder, "Skyrim - Interface.bsa"));
        File.WriteAllText(Path.Combine(_dataFolder, "Skyrim - Misc.bsa"), "not an archive");
        TheGameLoads("Skyrim - Misc.bsa", "Skyrim - Interface.bsa");

        using var documents = OpenDocuments(_pluginPath).Answered();

        Assert.Contains(DoorName, documents.Records.Single().Text, StringComparison.Ordinal);
    }

    [Fact]
    public void OpenDocuments_AnArchiveTheGameLoadsRewrittenAfterARead_IsReadAgain()
    {
        var interfaceArchive = Path.Combine(_dataFolder, "Skyrim - Interface.bsa");
        var otherPlugin = Path.Combine(Directory.CreateDirectory(Path.Combine(_root, "Other")).FullName, "Other.esm");
        LocalizedDoorPlugin.Write(otherPlugin, "Another Door");
        LocalizedDoorPlugin.PackStrings(otherPlugin, interfaceArchive);
        Directory.Delete(LocalizedDoorPlugin.LooseStrings(_pluginPath), recursive: true);
        TheGameLoads("Skyrim - Interface.bsa");
        OpenDocuments(_pluginPath).Answered().Dispose();
        LocalizedDoorPlugin.Write(_pluginPath, DoorName);
        LocalizedDoorPlugin.PackStrings(_pluginPath, interfaceArchive);

        using var documents = OpenDocuments(_pluginPath).Answered();

        Assert.Contains(DoorName, documents.Records.Single().Text, StringComparison.Ordinal);
    }

    [Fact]
    public void OpenDocuments_APluginThatIsNotLocalizedBesideACorruptArchiveNamedForIt_Opens()
    {
        LocalizedDoorPlugin.WriteNameInPlugin(_pluginPath, DoorName);
        File.WriteAllText(Path.Combine(_modFolder, "Update.bsa"), "not an archive");

        using var documents = OpenDocuments(_pluginPath).Answered();

        Assert.Contains(DoorName, documents.Records.Single().Text, StringComparison.Ordinal);
    }

    [Fact]
    public void OpenDocuments_AFallout4MasterWhoseStringsAreOnlyInAGeneralArchiveTheGameLoads_ReadsItsNames()
    {
        const string master = "DLCRobot.esm";
        var masterPath = Path.Combine(_dataFolder, master);
        LocalizedDoorPlugin.WriteFallout4(masterPath, DoorName);
        LocalizedDoorPlugin.PackStrings(masterPath, Path.Combine(_dataFolder, "Fallout4 - Interface.ba2"));
        var copy = new RegisteredPlugin(master, PluginOrigin.DataDirectory, masterPath, PluginProvider.Game, Line: null, HandedStrings.Of(masterPath));

        using var documents = Adapter.OpenDocuments(
            new ModPath(ModKey.FromFileName(master), masterPath),
            new LoadOrderSnapshot(_dataFolder, null, GameRelease.Fallout4, [copy], [copy.Key], [copy.Key], [HandedStrings.Stamped(Path.Combine(_dataFolder, "Fallout4 - Interface.ba2"))], [], [], Language.English),
            SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4), copy.Strings).Answered();

        Assert.Contains(DoorName, documents.Records.Single().Text, StringComparison.Ordinal);
    }

    private async Task<string> DoorSource() =>
        (await Adapter.ReadSourceOfAsync(Plugin, LoadOrder)).Answered().Files
            .Select(file => Encoding.UTF8.GetString(file.Content))
            .Single(content => content.Contains("MainDoor", StringComparison.Ordinal) && content.Contains("Values", StringComparison.Ordinal));

    private void WriteOnlyFrenchStringsBesideThePlugin()
    {
        LocalizedDoorPlugin.Write(_pluginPath, "La Grande Porte", Language.French);
        File.Delete(Path.Combine(LocalizedDoorPlugin.LooseStrings(_pluginPath), "Update_French.ILSTRINGS"));
        File.Delete(Path.Combine(LocalizedDoorPlugin.LooseStrings(_pluginPath), "Update_French.DLSTRINGS"));
    }

    private void TheGameLoads(params string[] archives) =>
        _archivesTheGameLoads = [.. archives.Select(archive => Path.Combine(_dataFolder, archive))];
}
