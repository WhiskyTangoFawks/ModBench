using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.RepositoriesLib;
using MEditService.SourceAdapter.Tests.TestSupport;
using MEditService.TestSupport;
using Microsoft.Extensions.Time.Testing;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.SourceAdapter.Tests.Source;

public sealed class NamedFilesReadAloneTests : IDisposable
{
    private const string PluginName = "Fixture.esp";
    private const string NpcFormKey = "000800:Fixture.esp";
    private const string CellFormKey = "000801:Fixture.esp";
    private const string StrayFormKey = "000802:Fixture.esp";
    private static readonly PluginAddress Plugin = new(PluginName, TestMod.Name);

    private readonly ScratchDirectory _modFolder = new("medit-named-files-");
    private readonly FakeTimeProvider _clock = new(TimeProvider.System.GetUtcNow());
    private readonly ISourceRepository _repository;

    public NamedFilesReadAloneTests()
    {
        PluginBaselines.InitWithNoRecords(_modFolder);
        _repository = TestAdapters.Source(_clock).Open(TestMod.In(_modFolder), GameRelease.Fallout4).Require();
        _repository.Put(Plugin, new SourceDocument(NpcFormKey, "npc_", "FixtureNpc", NpcBody(NpcFormKey))).Wrote();
        _repository.Put(Plugin, new SourceDocument(CellFormKey, "cell", "FixtureCell", RecordTextCodec.SerializeToText(
            new Cell(FormKey.Factory(CellFormKey), Fallout4Release.Fallout4) { EditorID = "FixtureCell" }, GameRelease.Fallout4))).Wrote();
    }

    public void Dispose() => _modFolder.Dispose();

    private static string NpcBody(string formKey) =>
        RecordTextCodec.SerializeToText(new Npc(FormKey.Factory(formKey), Fallout4Release.Fallout4) { EditorID = "FixtureNpc" }, GameRelease.Fallout4);

    private string FileOf(string formKey, string recordType, string editorId) =>
        _repository.DocumentOf(Plugin, new RecordIdentity(formKey, recordType, editorId)).Value().Require().Path;

    private string NpcFile => FileOf(NpcFormKey, "npc_", "FixtureNpc");

    private string CellFile => Directory.GetFiles(_modFolder, "*000801_Fixture.esp.json", SearchOption.AllDirectories).Single();

    private IReadOnlyList<string> Listed(IReadOnlyList<string> named)
    {
        _ = _repository.StampsOf(Plugin);
        return named;
    }

    private string InAnotherPluginsTree()
    {
        var separator = Path.DirectorySeparatorChar;
        var path = NpcFile.Replace($"{separator}{PluginName}{separator}", $"{separator}Other.esp{separator}", StringComparison.Ordinal);
        Directory.CreateDirectory(Path.GetDirectoryName(path).Require());
        return path;
    }

    private static string Written(string path, string text)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path).Require());
        File.WriteAllText(path, text);
        return path;
    }

    private static readonly Dictionary<string, Func<NamedFilesReadAloneTests, IReadOnlyList<string>>> FallingBack = new()
    {
        ["more paths than git takes"] = test => test.Listed([.. Enumerable.Repeat(test.NpcFile, 101)]),
        ["a path in another plugin's tree"] = test => test.Listed([Written(test.InAnotherPluginsTree(), NpcBody(StrayFormKey))]),
        ["a tree never listed"] = test => [test.NpcFile],
        ["a FormKey another file holds"] = test => test.Listed([Written(Path.Combine(Path.GetDirectoryName(test.NpcFile).Require(), "Copy.json"), NpcBody(NpcFormKey))]),
        ["a file beside a cell's own document"] = test => test.Listed([Written(
            Path.Combine(Path.GetDirectoryName(test.CellFile).Require(), "Stray.json"), NpcBody(StrayFormKey))]),
        ["a group's document"] = test => test.Listed([Directory.GetFiles(test._modFolder, "GroupRecordData.json", SearchOption.AllDirectories).First()]),
        ["a file neither on disk nor listed"] = test => test.Listed([Path.Combine(Path.GetDirectoryName(test.NpcFile).Require(), "Never.json")]),
    };

    public static TheoryData<string> FallBacks() => [.. FallingBack.Keys];

    [Theory]
    [MemberData(nameof(FallBacks))]
    public void NamedFilesThatDoNotReadAlone_AnswerNone_SoThePluginIsReadWhole(string named)
    {
        var files = FallingBack[named](this);

        Assert.Null(_repository.ReadFiles(Plugin, files, []).Value());
    }

    [Fact]
    public void ANamedFileOfAListedTree_ReadsAlone()
    {
        var files = Listed([NpcFile]);

        Assert.Equal([NpcFormKey], _repository.ReadFiles(Plugin, files, []).Value().Require().Documents.Select(document => document.FormKey));
    }

    [Fact]
    public void ANamedFileReadGone_ReadsAloneAgain_HoldingNothing()
    {
        var npc = NpcFile;
        _ = Listed([npc]);
        File.Delete(npc);
        Assert.Equal([NpcFormKey], _repository.ReadFiles(Plugin, [npc], []).Value().Require().Gone);

        var again = _repository.ReadFiles(Plugin, [npc], []).Value().Require();

        Assert.Equal((0, 0), (again.Documents.Count, again.Gone.Count));
    }

    private static WrittenDocument WrittenWithAnotherEditorIdThanTheFile(string path) =>
        new(path, File.ReadAllText(path).Replace("FixtureNpc", "HandedNpc", StringComparison.Ordinal), WrittenStamp.Of(path).Require());

    private static string ReadText(FilesRead read) => read.Documents.Single().Text;

    [Fact]
    public void AWrittenDocument_IsReadInPlaceOfItsFile_WhileTheFileKeepsItsStamp()
    {
        var npc = Listed([NpcFile])[0];

        var read = _repository.ReadFiles(Plugin, [npc], [WrittenWithAnotherEditorIdThanTheFile(npc)]).Value().Require();

        Assert.Contains("HandedNpc", ReadText(read), StringComparison.Ordinal);
    }

    [Fact]
    public void AWrittenDocumentWhoseFileWasWrittenAgain_IsReadFromTheFile()
    {
        var npc = Listed([NpcFile])[0];
        var written = WrittenWithAnotherEditorIdThanTheFile(npc);
        File.AppendAllText(npc, " ");

        var read = _repository.ReadFiles(Plugin, [npc], [written]).Value().Require();

        Assert.Contains("FixtureNpc", ReadText(read), StringComparison.Ordinal);
    }

    [Fact]
    public void AFileWhoseWrittenDocumentWasReadBeforeItsStampSettled_IsReadAgain()
    {
        var npc = Listed([NpcFile])[0];
        _ = _repository.ReadFiles(Plugin, [npc], [WrittenWithAnotherEditorIdThanTheFile(npc)]).Value();

        var again = _repository.ReadFiles(Plugin, [npc], []).Value().Require();

        Assert.Contains("FixtureNpc", ReadText(again), StringComparison.Ordinal);
    }

    [Fact]
    public void AFileReadOnceItsStampSettled_IsNotReadAgainWhileItKeepsIt()
    {
        var npc = Listed([NpcFile])[0];
        _clock.Advance(TimeSpan.FromSeconds(3));
        _ = _repository.ReadFiles(Plugin, [npc], []).Value();

        var again = _repository.ReadFiles(Plugin, [npc], []).Value().Require();

        Assert.Equal((0, 0), (again.Documents.Count, again.Gone.Count));
    }

    [Fact]
    public void AFileReadOnceItsStampSettled_IsReadAgainOnceWrittenAgain()
    {
        var npc = Listed([NpcFile])[0];
        _clock.Advance(TimeSpan.FromSeconds(3));
        _ = _repository.ReadFiles(Plugin, [npc], []).Value();
        File.AppendAllText(npc, " ");

        var again = _repository.ReadFiles(Plugin, [npc], []).Value().Require();

        Assert.Single(again.Documents);
    }
}
