using System.Text;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Skyrim;
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
        WritePluginNamingItsDoor(DoorName);
    }

    private void WritePluginNamingItsDoor(string doorName)
    {
        var mod = new SkyrimMod(ModKey.FromFileName(PluginName), SkyrimRelease.SkyrimSE) { UsingLocalization = true };
        mod.Doors.AddNew("MainDoor").Name = new TranslatedString(Language.English, doorName);
        ((IModGetter)mod).WriteToBinary(_pluginPath);
    }

    public void Dispose() => _root.Dispose();

    private PluginStrings Strings => new(_modFolder, _dataFolder);

    private LoadOrderSnapshot LoadOrder => new(_dataFolder, null, GameRelease.SkyrimSE, [], [], []);

    private RegisteredPlugin Plugin => new(PluginName, ModName, _pluginPath, new PluginProvider.FromMod(ModName, _modFolder), Line: null);

    private void MoveStringsIntoGameDataArchive(string archiveName)
    {
        var looseStrings = Path.Combine(_modFolder, "Strings");
        StringsArchive.Pack(Directory.EnumerateFiles(looseStrings), Path.Combine(_dataFolder, archiveName));
        Directory.Delete(looseStrings, recursive: true);
    }

    private RepositoriesLib.Answer<IPluginDocuments, PluginFailure> OpenDocuments() =>
        Adapter.OpenDocuments(
            new ModPath(ModKey.FromFileName(PluginName), _pluginPath), LoadOrder,
            SharedSchemaReflector.Instance.GetSchemas(GameRelease.SkyrimSE), Strings);

    [Fact]
    public async Task ReadSourceOf_APluginWhoseStringsAreInTheGameDataFoldersArchiveForIt_ReadsThemFromThere()
    {
        MoveStringsIntoGameDataArchive("Update.bsa");

        var source = (await Adapter.ReadSourceOfAsync(Plugin, LoadOrder, Strings)).Answered();

        Assert.Contains(source.Files, file => Encoding.UTF8.GetString(file.Content).Contains(DoorName, StringComparison.Ordinal));
    }

    [Fact]
    public void OpenDocuments_APluginWhoseStringsAreInTheGameDataFoldersArchiveForIt_ReadsItsNamesFromThere()
    {
        MoveStringsIntoGameDataArchive("Update.bsa");

        using var documents = OpenDocuments().Answered();

        Assert.Contains(DoorName, documents.Records.Single().Text, StringComparison.Ordinal);
    }

    [Fact]
    public void OpenDocuments_APluginWhoseStringsAreBesideItAndInTheGameDataFolder_ReadsTheOnesBesideIt()
    {
        MoveStringsIntoGameDataArchive("Update.bsa");
        WritePluginNamingItsDoor("The Mod's Door");

        using var documents = OpenDocuments().Answered();

        Assert.Contains("The Mod's Door", documents.Records.Single().Text, StringComparison.Ordinal);
    }

    [Fact]
    public void OpenRecordLookup_APluginWhoseStringsAreInTheGameDataFoldersArchiveForIt_ReadsItsNamesFromThere()
    {
        MoveStringsIntoGameDataArchive("Update.bsa");

        using var records = Adapter.OpenRecordLookup(Plugin, LoadOrder, SharedSchemaReflector.Instance.GetSchemas(GameRelease.SkyrimSE)).Answered();

        Assert.Contains(DoorName, records.TextOf("000800:Update.esm").Answered(), StringComparison.Ordinal);
    }

    [Fact]
    public void OpenDocuments_APluginWhoseStringsAreNowhereTheGameLooks_FailsNamingTheMissingFile()
    {
        Directory.Delete(Path.Combine(_modFolder, "Strings"), recursive: true);

        Assert.False(OpenDocuments().Holds(out _, out var failure));
        Assert.Equal("Update_English.STRINGS", Assert.IsType<PluginFailure.MissingStrings>(failure).File);
    }
}
