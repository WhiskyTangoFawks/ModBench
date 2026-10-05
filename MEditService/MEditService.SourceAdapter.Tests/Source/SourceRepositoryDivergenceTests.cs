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

    private static readonly PluginAddress Plugin = new(PluginName, "DivergeMod");
    private static readonly RecordIdentity Npc = new(NpcFormKey, "npc_", "FixtureNpc");
    private static readonly TreeFile Extra = new(Path.Combine("npc_", "Extra.json"), Different);

    private readonly ScratchDirectory _modFolder = new("medit-diverge-");

    public SourceRepositoryDivergenceTests()
    {
        PluginBaselines.Track(
            _modFolder,
            [new TreeFile(Path.Combine(PluginSourceRoot.For(PluginName), "RecordData.json"), "{\"MasterReferences\": []}"u8.ToArray())]);
        Repository.Put(Plugin, new SourceDocument(NpcFormKey, "npc_", "FixtureNpc", NpcBody));
    }

    public void Dispose() => _modFolder.Dispose();

    private SourceRepository Repository =>
        SourceRepository.Open(TestMod.In(_modFolder), GameRelease.Fallout4)
            ?? throw new InvalidOperationException($"Expected '{_modFolder}' to already be tracked.");

    private static string HeaderPath => Path.Combine(PluginSourceRoot.For(PluginName), "RecordData.json");

    private static string ExtraPath => SourceRepository.PristineFilesOf(PluginName, [Extra]).Single().RelativePath;

    private string NpcPath =>
        Repository.RelativePathOf(Plugin, Npc)
            ?? throw new InvalidOperationException($"Expected the tree to hold {NpcFormKey}.");

    private static string DoorPathOf(string modFolderPath) =>
        Path.GetRelativePath(PluginSourceRoot.For(PluginName), modFolderPath);

    private List<TreeFile> Serialized(Func<TreeFile, TreeFile?>? change = null) =>
    [
        .. Repository.FilesOf(Plugin).Files
            .Select(file => new TreeFile(DoorPathOf(file.RelativePath), file.Content))
            .Select(change ?? (file => file))
            .OfType<TreeFile>(),
    ];

    private static Func<TreeFile, TreeFile?> Respelling(string modFolderPath) =>
        file => file.RelativePath == DoorPathOf(modFolderPath) ? file with { Content = Different } : file;

    private static Func<TreeFile, TreeFile?> Omitting(string modFolderPath) =>
        file => file.RelativePath == DoorPathOf(modFolderPath) ? null : file;

    [Fact]
    public void DivergenceFrom_ASerializationOfTheSameTree_IsNone()
    {
        Assert.Null(Repository.DivergenceFrom(Plugin, Serialized()));
    }

    [Fact]
    public void DivergenceFrom_ADocumentTheSerializationSpellsDifferently_IsDocumentChanged_AtThatDocument()
    {
        Assert.Equal(
            new SourceDivergence(SourceDivergenceKind.DocumentChanged, NpcPath),
            Repository.DivergenceFrom(Plugin, Serialized(Respelling(NpcPath))));
    }

    [Fact]
    public void DivergenceFrom_TheHeaderSpelledDifferently_IsHeaderChanged_AtTheHeader()
    {
        Assert.Equal(
            new SourceDivergence(SourceDivergenceKind.HeaderChanged, HeaderPath),
            Repository.DivergenceFrom(Plugin, Serialized(Respelling(HeaderPath))));
    }

    [Fact]
    public void DivergenceFrom_ADocumentOnDiskTheSerializationDoesNotProduce_IsUnproduced_AtThatDocument()
    {
        Assert.Equal(
            new SourceDivergence(SourceDivergenceKind.Unproduced, NpcPath),
            Repository.DivergenceFrom(Plugin, Serialized(Omitting(NpcPath))));
    }

    [Fact]
    public void DivergenceFrom_ADocumentTheSerializationWritesAndTheDiskLacks_IsDocumentChanged_AtThatDocument()
    {
        Assert.Equal(
            new SourceDivergence(SourceDivergenceKind.DocumentChanged, ExtraPath),
            Repository.DivergenceFrom(Plugin, [.. Serialized(), Extra]));
    }

    [Fact]
    public void DivergenceFrom_AChangeAndAnUnproducedDocument_AnswersTheChange()
    {
        var serialized = Serialized(file => Respelling(HeaderPath)(file) is { } respelled ? Omitting(NpcPath)(respelled) : null);

        Assert.Equal(
            new SourceDivergence(SourceDivergenceKind.HeaderChanged, HeaderPath),
            Repository.DivergenceFrom(Plugin, serialized));
    }

    [Fact]
    public void DivergenceFrom_SeveralChanges_AnswersTheFirstInTheOrderTheDoorWrites()
    {
        var respelledHeader = Serialized(Respelling(HeaderPath));

        Assert.Equal(
            SourceDivergenceKind.HeaderChanged,
            Repository.DivergenceFrom(Plugin, [.. respelledHeader, Extra])?.Kind);
        Assert.Equal(
            new SourceDivergence(SourceDivergenceKind.DocumentChanged, ExtraPath),
            Repository.DivergenceFrom(Plugin, [Extra, .. respelledHeader]));
    }

    [Fact]
    public void DivergenceFrom_AFileThatCannotBeRead_IsUnreadable_AheadOfAnyChange()
    {
        var npcPath = NpcPath;
        var serialized = Serialized(Respelling(HeaderPath));
        using var held = new FileStream(Path.Combine(_modFolder, npcPath), FileMode.Open, FileAccess.Read, FileShare.None);

        Assert.Equal(
            new SourceDivergence(SourceDivergenceKind.Unreadable, npcPath),
            Repository.DivergenceFrom(Plugin, serialized));
    }
}
