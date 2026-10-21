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
    public void Compare_ASerializationOfTheSameTree_IsNone()
    {
        Assert.Empty(Repository.Compare(Plugin, Serialized()).Value().Divergences);
    }

    [Fact]
    public void Compare_ADocumentTheSerializationSpellsDifferently_IsDocumentChanged_AtThatDocument()
    {
        Assert.Equal([(SourceDivergenceKind.DocumentChanged, NpcPath)], Divergences(Serialized(Respelling(NpcPath))));
    }

    [Fact]
    public void Compare_TheHeaderSpelledDifferently_IsHeaderChanged_AtTheHeader()
    {
        Assert.Equal([(SourceDivergenceKind.HeaderChanged, HeaderPath)], Divergences(Serialized(Respelling(HeaderPath))));
    }

    [Fact]
    public void Compare_ADocumentOnDiskTheSerializationDoesNotProduce_IsUnproduced_AtThatDocument()
    {
        Assert.Equal([(SourceDivergenceKind.Unproduced, NpcPath)], Divergences(Serialized(Omitting(NpcPath))));
    }

    [Fact]
    public void Compare_ADocumentTheSerializationWritesAndTheDiskLacks_IsDocumentChanged_AtThatDocument()
    {
        Assert.Equal([(SourceDivergenceKind.DocumentChanged, ExtraPath)], Divergences([.. Serialized(), Extra]));
    }

    [Fact]
    public void Compare_AChangeAndAnUnproducedDocument_ListsTheChangeFirst()
    {
        var serialized = Serialized(file => Respelling(HeaderPath)(file) is { } respelled ? Omitting(NpcPath)(respelled) : null);

        Assert.Equal([(SourceDivergenceKind.HeaderChanged, HeaderPath), (SourceDivergenceKind.Unproduced, NpcPath)], Divergences(serialized));
    }

    [Fact]
    public void Compare_SeveralChanges_ListsEveryOneInTheOrderTheDoorWrites()
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
    public void Compare_ADocumentOfAnotherMeaning_NamesTheFieldThatDiffers()
    {
        var divergence = Assert.Single(Repository.Compare(Plugin, Serialized(Respelling(NpcPath))).Value().Divergences);

        Assert.Equal("FormKey", divergence.Field);
    }

    [Fact]
    public void Compare_ADocumentReformattedAndReordered_IsNoDivergence()
    {
        var serialized = Serialized();
        File.WriteAllText(Path.Combine(_modFolder, NpcPath), "{\"EditorID\":\"FixtureNpc\",\n\n\"FormKey\":\"000800:Diverge.esp\"}");

        Assert.Empty(Repository.Compare(Plugin, serialized).Value().Divergences);
    }

    [Fact]
    public void Compare_AFileThatCannotBeRead_IsUnreadable_AheadOfAnyChange()
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
    public void Compare_AFileRenamedByHand_IsMisplaced_NamingWhereItBelongs_AndNoDivergence()
    {
        var serialized = Serialized();
        var npcPath = RenameTheNpcFile(out var renamedPath);

        var comparison = Repository.Compare(Plugin, serialized).Value();

        Assert.Empty(comparison.Divergences);
        Assert.Equal([new MisplacedFile(NpcFormKey, renamedPath, npcPath)], comparison.Misplaced);
    }

    [Fact]
    public void Compare_AFileRenamedByHandAndReformatted_IsMisplaced_NotADivergence()
    {
        var serialized = Serialized();
        var npcPath = RenameTheNpcFile(out var renamedPath);
        File.AppendAllText(Path.Combine(_modFolder, renamedPath), " ");

        var comparison = Repository.Compare(Plugin, serialized).Value();

        Assert.Empty(comparison.Divergences);
        Assert.Equal([new MisplacedFile(NpcFormKey, renamedPath, npcPath)], comparison.Misplaced);
    }

    [Fact]
    public void Compare_AFileRenamedByHandAndChangedInMeaning_IsADivergence_NotAMisplacement()
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
