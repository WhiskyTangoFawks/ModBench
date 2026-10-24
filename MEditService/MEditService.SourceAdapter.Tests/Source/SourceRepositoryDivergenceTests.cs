using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceAdapter.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.SourceAdapter.Tests.Source;

public sealed class SourceRepositoryDivergenceTests : IDisposable
{
    private const string PluginName = "Diverge.esp";
    private const string NpcFormKey = "000800:Diverge.esp";
    private const string NpcBody = "{\n  \"FormKey\": \"000800:Diverge.esp\",\n  \"EditorID\": \"FixtureNpc\"\n}";
    private static readonly byte[] Different = "{}"u8.ToArray();

    private static readonly PluginAddress Plugin = new(PluginName, TestMod.Name);
    private static readonly RecordIdentity Npc = new(NpcFormKey, "npc_", "FixtureNpc");
    private static readonly TreeFile Extra = new(Path.Combine("npc_", "Extra.json"), Different);

    private readonly ScratchDirectory _modFolder = new("medit-diverge-");

    public SourceRepositoryDivergenceTests()
    {
        PluginBaselines.Init(
            _modFolder,
            [new TreeFile(PluginSourceRoot.HeaderDocument(PluginName), "{\"Author\": \"held\"}"u8.ToArray())]);
        Repository.Put(Plugin, new SourceDocument(NpcFormKey, "npc_", "FixtureNpc", NpcBody)).Wrote();
    }

    public void Dispose() => _modFolder.Dispose();

    private ISourceRepository Repository =>
        TestAdapters.OpenSourceMod(_modFolder, GameRelease.Fallout4);

    private static string HeaderPath => PluginSourceRoot.HeaderDocument(PluginName);

    private static string ExtraPath => Path.Combine(PluginSourceRoot.For(PluginName), Extra.RelativePath);

    private string NpcPath =>
        Repository.RelativePathOf(Plugin, Npc).Value()
            ?? throw new InvalidOperationException($"Expected the tree to hold {NpcFormKey}.");

    private static string DoorPathOf(string modFolderPath) =>
        modFolderPath == HeaderPath ? "RecordData.json" : Path.GetRelativePath(PluginSourceRoot.For(PluginName), modFolderPath);

    private List<TreeFile> Serialized(Func<TreeFile, TreeFile?>? change = null) =>
    [
        .. Repository.TreeOf(Plugin).Value().Files
            .Select(change ?? (file => file))
            .OfType<TreeFile>(),
    ];

    private static Func<TreeFile, TreeFile?> Respelling(string modFolderPath) =>
        file => file.RelativePath == DoorPathOf(modFolderPath) ? file with { Content = Different } : file;

    private static Func<TreeFile, TreeFile?> Omitting(string modFolderPath) =>
        file => file.RelativePath == DoorPathOf(modFolderPath) ? null : file;

    private (SourceDivergenceKind Kind, string Path)[] Divergences(IReadOnlyList<TreeFile> serialized) =>
        [.. Repository.Compare(Plugin, serialized).Value().Divergences.Select(divergence => (divergence.Kind, divergence.Path))];

    [Fact]
    public void ASerializationOfTheSameTree_IsNoDivergence()
    {
        Assert.Empty(Repository.Compare(Plugin, Serialized()).Value().Divergences);
    }

    public enum Serializing
    {
        TheNpcSpelledDifferently,
        TheHeaderSpelledDifferently,
        NoNpc,
        AnExtraDocument,
    }

    private (List<TreeFile> Serialized, (SourceDivergenceKind Kind, string Path) Divergence) SerializationAndDivergence(Serializing serializing) =>
        serializing switch
        {
            Serializing.TheNpcSpelledDifferently => (Serialized(Respelling(NpcPath)), (SourceDivergenceKind.DocumentChanged, NpcPath)),
            Serializing.TheHeaderSpelledDifferently => (Serialized(Respelling(HeaderPath)), (SourceDivergenceKind.HeaderChanged, HeaderPath)),
            Serializing.NoNpc => (Serialized(Omitting(NpcPath)), (SourceDivergenceKind.Unproduced, NpcPath)),
            Serializing.AnExtraDocument => ([.. Serialized(), Extra], (SourceDivergenceKind.DocumentChanged, ExtraPath)),
            _ => throw new ArgumentOutOfRangeException(nameof(serializing), serializing, null),
        };

    [Theory]
    [InlineData(Serializing.TheNpcSpelledDifferently)]
    [InlineData(Serializing.TheHeaderSpelledDifferently)]
    [InlineData(Serializing.NoNpc)]
    [InlineData(Serializing.AnExtraDocument)]
    public void ASerializationThatPartsWaysWithTheDisk_IsOneDivergence_OfItsKind_AtThatDocument(Serializing serializing)
    {
        var (serialized, divergence) = SerializationAndDivergence(serializing);

        Assert.Equal([divergence], Divergences(serialized));
    }

    [Fact]
    public void AChangeAndAnUnproducedDocument_ListTheChangeFirst()
    {
        var serialized = Serialized(file => Respelling(HeaderPath)(file) is { } respelled ? Omitting(NpcPath)(respelled) : null);

        Assert.Equal([(SourceDivergenceKind.HeaderChanged, HeaderPath), (SourceDivergenceKind.Unproduced, NpcPath)], Divergences(serialized));
    }

    [Fact]
    public void SeveralChanges_ListEveryOneInTheOrderTheDoorWrites()
    {
        var respelledHeader = Serialized(Respelling(HeaderPath));

        Assert.Equal(
            [(SourceDivergenceKind.HeaderChanged, HeaderPath), (SourceDivergenceKind.DocumentChanged, ExtraPath)],
            Divergences([.. respelledHeader, Extra]));
        Assert.Equal(
            [(SourceDivergenceKind.DocumentChanged, ExtraPath), (SourceDivergenceKind.HeaderChanged, HeaderPath)],
            Divergences([Extra, .. respelledHeader]));
    }

    [Fact]
    public void ADocumentOfAnotherMeaning_NamesTheFieldThatDiffers()
    {
        var divergence = Assert.Single(Repository.Compare(Plugin, Serialized(Respelling(NpcPath))).Value().Divergences);

        Assert.Equal("FormKey", divergence.Field);
    }

    [Fact]
    public void ADocumentReformattedAndReordered_IsNoDivergence()
    {
        var serialized = Serialized();
        File.WriteAllText(Path.Combine(_modFolder, NpcPath), "{\"EditorID\":\"FixtureNpc\",\n\n\"FormKey\":\"000800:Diverge.esp\"}");

        Assert.Empty(Repository.Compare(Plugin, serialized).Value().Divergences);
    }

    [Fact]
    public void AFileThatCannotBeRead_IsUnreadable_AheadOfAnyChange()
    {
        var npcPath = NpcPath;
        var serialized = Serialized(Respelling(HeaderPath));
        using var held = new FileStream(Path.Combine(_modFolder, npcPath), FileMode.Open, FileAccess.Read, FileShare.None);

        Assert.Equal([(SourceDivergenceKind.Unreadable, npcPath)], Divergences(serialized));
    }

    private string RenameTheNpcFile(out string renamedPath)
    {
        var npcPath = NpcPath;
        renamedPath = Path.Combine(Path.GetDirectoryName(npcPath) ?? string.Empty, "ByHand.json");
        File.Move(Path.Combine(_modFolder, npcPath), Path.Combine(_modFolder, renamedPath));
        return npcPath;
    }

    [Fact]
    public void AFileRenamedByHand_IsMisplaced_NamingWhereItBelongs_AndNoDivergence()
    {
        var serialized = Serialized();
        var npcPath = RenameTheNpcFile(out var renamedPath);

        var comparison = Repository.Compare(Plugin, serialized).Value();

        Assert.Empty(comparison.Divergences);
        Assert.Equal([new MisplacedFile(NpcFormKey, renamedPath, npcPath)], comparison.Misplaced);
    }

    [Fact]
    public void AFileRenamedByHandAndReformatted_IsMisplaced_NotADivergence()
    {
        var serialized = Serialized();
        var npcPath = RenameTheNpcFile(out var renamedPath);
        File.AppendAllText(Path.Combine(_modFolder, renamedPath), " ");

        var comparison = Repository.Compare(Plugin, serialized).Value();

        Assert.Empty(comparison.Divergences);
        Assert.Equal([new MisplacedFile(NpcFormKey, renamedPath, npcPath)], comparison.Misplaced);
    }

    [Fact]
    public void AContainersDirectoryRenamedByHand_IsMisplaced_NamingWhereItsDocumentBelongs_AndNoDivergence()
    {
        Repository.Put(Plugin, new SourceDocument(CellFormKey, "cell", "Room", CellBody)).Wrote();
        var serialized = Serialized();
        var held = Repository.RelativePathOf(Plugin, new RecordIdentity(CellFormKey, "cell", "Room")).Value().Require();
        var renamed = Path.Combine(Path.GetDirectoryName(Path.GetDirectoryName(held)).Require(), "ByHand", Path.GetFileName(held));
        Directory.Move(Path.Combine(_modFolder, Path.GetDirectoryName(held).Require()), Path.Combine(_modFolder, Path.GetDirectoryName(renamed).Require()));

        var comparison = Repository.Compare(Plugin, serialized).Value();

        Assert.Empty(comparison.Divergences);
        Assert.Equal([new MisplacedFile(CellFormKey, renamed, held)], comparison.Misplaced);
    }

    private const string CellFormKey = "000900:Diverge.esp";
    private const string CellBody = "{\n  \"FormKey\": \"000900:Diverge.esp\",\n  \"EditorID\": \"Room\"\n}";

    [Fact]
    public void AFileRenamedByHandAndChangedInMeaning_IsADivergence_NotAMisplacement()
    {
        var serialized = Serialized();
        var npcPath = RenameTheNpcFile(out var renamedPath);
        File.WriteAllText(Path.Combine(_modFolder, renamedPath), NpcBody.Replace("FixtureNpc", "Renamed", StringComparison.Ordinal));

        var comparison = Repository.Compare(Plugin, serialized).Value();

        Assert.Empty(comparison.Misplaced);
        Assert.Equal(
            [(SourceDivergenceKind.DocumentChanged, npcPath), (SourceDivergenceKind.Unproduced, renamedPath)],
            comparison.Divergences.Select(divergence => (divergence.Kind, divergence.Path)));
    }
}
