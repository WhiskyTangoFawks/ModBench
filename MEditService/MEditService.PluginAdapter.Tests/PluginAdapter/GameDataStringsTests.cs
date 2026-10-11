using System.Text;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.PluginAdapter.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

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

    private LoadOrderSnapshot LoadOrder => new(_dataFolder, null, GameRelease.SkyrimSE, [], [], [], _archivesTheGameLoads);

    private RegisteredPlugin Plugin => new(PluginName, ModName, _pluginPath, new PluginProvider.FromMod(ModName, _modFolder), Line: null);

    private void MoveStringsIntoGameData(string archiveName) => LocalizedDoorPlugin.PackStrings(_pluginPath, Path.Combine(_dataFolder, archiveName));

    private RepositoriesLib.Answer<IPluginDocuments, PluginFailure> OpenDocuments(string pluginPath) =>
        Adapter.OpenDocuments(
            new ModPath(ModKey.FromFileName(PluginName), pluginPath), LoadOrder,
            SharedSchemaReflector.Instance.GetSchemas(GameRelease.SkyrimSE),
            new PluginStrings(Path.GetDirectoryName(pluginPath), _dataFolder));

    [Fact]
    public async Task ReadSourceOf_APluginWhoseStringsAreInTheGameDataFoldersArchiveForIt_ReadsThemFromThere()
    {
        MoveStringsIntoGameData("Update.bsa");

        var source = (await Adapter.ReadSourceOfAsync(Plugin, LoadOrder, new PluginStrings(_modFolder, _dataFolder))).Answered();

        Assert.Contains(source.Files, file => Encoding.UTF8.GetString(file.Content).Contains(DoorName, StringComparison.Ordinal));
    }

    [Fact]
    public void OpenDocuments_APluginWhoseStringsAreInTheGameDataFoldersArchiveForIt_ReadsItsNamesFromThere()
    {
        MoveStringsIntoGameData("Update.bsa");

        using var documents = OpenDocuments(_pluginPath).Answered();

        Assert.Contains(DoorName, documents.Records.Single().Text, StringComparison.Ordinal);
    }

    [Fact]
    public void OpenDocuments_APluginWhoseStringsAreBesideItAndInTheGameDataFolder_ReadsTheOnesBesideIt()
    {
        MoveStringsIntoGameData("Update.bsa");
        LocalizedDoorPlugin.Write(_pluginPath, "The Mod's Door");

        using var documents = OpenDocuments(_pluginPath).Answered();

        Assert.Contains("The Mod's Door", documents.Records.Single().Text, StringComparison.Ordinal);
    }

    [Fact]
    public void OpenRecordLookup_APluginWhoseStringsAreInTheGameDataFoldersArchiveForIt_ReadsItsNamesFromThere()
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

        var source = (await Adapter.ReadSourceOfAsync(Plugin, LoadOrder, new PluginStrings(_modFolder, _dataFolder))).Answered();

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
    public void OpenDocuments_APluginWithStringsInAnArchiveNamedForItAndInAnotherTheGameLoads_ReadsTheNamedOne()
    {
        LocalizedDoorPlugin.Write(_pluginPath, "The Old Door");
        LocalizedDoorPlugin.PackStrings(_pluginPath, Path.Combine(_dataFolder, "Skyrim - Interface.bsa"));
        LocalizedDoorPlugin.Write(_pluginPath, DoorName);
        MoveStringsIntoGameData("Update.bsa");
        TheGameLoads("Skyrim - Interface.bsa");

        using var documents = OpenDocuments(_pluginPath).Answered();

        Assert.Contains(DoorName, documents.Records.Single().Text, StringComparison.Ordinal);
    }

    [Fact]
    public void OpenDocuments_AModFolderHoldingOnlyOneOfAPluginsStringsFiles_ReadsThatOneFromItAndTheRestFromTheGame()
    {
        MoveStringsIntoGameData("Update.bsa");
        LocalizedDoorPlugin.Write(_pluginPath, "The Mod's Door");
        foreach (var dlOrIl in Directory.EnumerateFiles(LocalizedDoorPlugin.LooseStrings(_pluginPath), "*LSTRINGS"))
            File.Delete(dlOrIl);

        using var documents = OpenDocuments(_pluginPath).Answered();

        Assert.Contains("The Mod's Door", documents.Records.Single().Text, StringComparison.Ordinal);
    }

    [Fact]
    public void OpenDocuments_APluginWhoseStringsAreNowhere_OpensWithItsNamesBlank()
    {
        Directory.Delete(LocalizedDoorPlugin.LooseStrings(_pluginPath), recursive: true);

        using var documents = OpenDocuments(_pluginPath).Answered();

        Assert.DoesNotContain(DoorName, documents.Records.Single().Text, StringComparison.Ordinal);
    }

    [Fact]
    public void OpenDocuments_ALocalizedPluginWhoseArchiveIsCorrupt_FailsNamingTheArchive()
    {
        Directory.Delete(LocalizedDoorPlugin.LooseStrings(_pluginPath), recursive: true);
        File.WriteAllText(Path.Combine(_dataFolder, "Update.bsa"), "not an archive");

        Assert.False(OpenDocuments(_pluginPath).Holds(out _, out var failure));
        Assert.Contains("Update.bsa", failure.Reason, StringComparison.Ordinal);
    }

    [Fact]
    public void OpenDocuments_APluginThatIsNotLocalizedBesideACorruptArchiveNamedForIt_Opens()
    {
        LocalizedDoorPlugin.Write(_pluginPath, DoorName, localized: false);
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
        LocalizedDoorPlugin.PackStringsBa2(masterPath, Path.Combine(_dataFolder, "Fallout4 - Interface.ba2"));

        using var documents = Adapter.OpenDocuments(
            new ModPath(ModKey.FromFileName(master), masterPath), new LoadOrderSnapshot(_dataFolder, null, GameRelease.Fallout4, [], [], [], [Path.Combine(_dataFolder, "Fallout4 - Interface.ba2")]),
            SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4), new PluginStrings(_dataFolder, _dataFolder)).Answered();

        Assert.Contains(DoorName, documents.Records.Single().Text, StringComparison.Ordinal);
    }

    private void TheGameLoads(params string[] archives) =>
        _archivesTheGameLoads = [.. archives.Select(archive => Path.Combine(_dataFolder, archive))];
}
