using System.Text;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceAdapter.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.SourceAdapter.Tests.Source;

public sealed class SourceRepositoryRenameSourceTests : IDisposable
{
    private const string LastWritten = "OLD-BINARY";
    private static readonly PluginAddress Old = new("Old.esp", TestMod.Name);
    private static readonly PluginAddress Other = new("Other.esp", TestMod.Name);
    private readonly ScratchDirectory _modFolder = new("medit-rename-source-");

    private static readonly (string Path, string Text)[] OldTree =
    [
        ("000000_Old.esp.json", """
            {
              "ModKey": "Old.esp",
              "ModHeader": {
                "MasterReferences": [ { "Master": "DLC.esm" } ]
              }
            }
            """),
        ("Npcs/SelfNpc - 000801_Old.esp.json", """
            {
              "FormKey": "000801:Old.esp",
              "EditorID": "SelfNpc",
              "Name": "Old.esp",
              "ShortName": "see 000802:Old.esp",
              "Race": "000802:Old.esp"
            }
            """),
        ("Npcs/MasterNpc - 000800_DLC.esm.json", """
            {
              "FormKey": "000800:DLC.esm",
              "Race": "000802:Old.esp"
            }
            """),
        ("Npcs/000803_BEEF01_Old.esp.json", """
            {
              "FormKey": "000803:BEEF01_Old.esp"
            }
            """),
        ("Cells/0/0/GroupRecordData.json", "{}"),
        ("Cells/0/0/EmbedCell - 000804_Old.esp/EmbedCell - 000804_Old.esp.json", """
            {
              "FormKey": "000804:Old.esp",
              "Temporary": [
                { "MutagenObjectType": "PlacedObject", "FormKey": "000805:Old.esp", "Base": "000800:DLC.esm" }
              ]
            }
            """),
    ];

    public SourceRepositoryRenameSourceTests() =>
        SourceRepository.Track(
            _modFolder,
            [
                (Files(OldTree), new DecompiledPlugin(Old.Name, LastWritten)),
                (Files([("000000_Other.esp.json", """{ "ModKey": "Other.esp" }""")]), new DecompiledPlugin(Other.Name, null)),
            ]);

    public void Dispose() => _modFolder.Dispose();

    [Fact]
    public void ChangesToRenameSource_MoveTheTreeToTheNewName_AndEveryFormKeyOfThePluginFollowsIt_InTextAndInLeafNames()
    {
        Assert.True(Rename("New.esm"));

        Assert.False(Directory.Exists(PluginSourceRoot.In(_modFolder, Old.Name)));
        Assert.Equal(
            [
                ("000000_New.esm.json", """
                    {
                      "ModKey": "New.esm",
                      "ModHeader": {
                        "MasterReferences": [ { "Master": "DLC.esm" } ]
                      }
                    }
                    """),
                ("Cells/0/0/EmbedCell - 000804_New.esm/EmbedCell - 000804_New.esm.json", """
                    {
                      "FormKey": "000804:New.esm",
                      "Temporary": [
                        { "MutagenObjectType": "PlacedObject", "FormKey": "000805:New.esm", "Base": "000800:DLC.esm" }
                      ]
                    }
                    """),
                ("Cells/0/0/GroupRecordData.json", "{}"),
                ("Npcs/000803_BEEF01_Old.esp.json", """
                    {
                      "FormKey": "000803:BEEF01_Old.esp"
                    }
                    """),
                ("Npcs/MasterNpc - 000800_DLC.esm.json", """
                    {
                      "FormKey": "000800:DLC.esm",
                      "Race": "000802:New.esm"
                    }
                    """),
                ("Npcs/SelfNpc - 000801_New.esm.json", """
                    {
                      "FormKey": "000801:New.esm",
                      "EditorID": "SelfNpc",
                      "Name": "Old.esp",
                      "ShortName": "see 000802:Old.esp",
                      "Race": "000802:New.esm"
                    }
                    """),
            ],
            TreeOf("New.esm"));
    }

    [Fact]
    public void ChangesToRenameSource_WriteNothing()
    {
        var before = TreeOf(Old.Name);
        var head = Git("rev-parse", "HEAD");

        var changes = Repository.ChangesToRenameSource(Old, "New.esp").Value().Require();

        Assert.NotEmpty(changes.Moves);
        Assert.Equal(before, TreeOf(Old.Name));
        Assert.Equal(["Old.esp", "Other.esp"], PluginSources());
        Assert.Equal(head, Git("rev-parse", "HEAD"));
    }

    [Fact]
    public void ChangesToRenameSource_AnswerADocumentOnlyWhenItsTextChanges()
    {
        var changes = Session().Repository.ChangesToRenameSource(Old, "New.esp").Value().Require();

        Assert.Equal(
            ["000000_New.esp.json", "Cells/0/0/EmbedCell - 000804_New.esp/EmbedCell - 000804_New.esp.json", "Npcs/MasterNpc - 000800_DLC.esm.json", "Npcs/SelfNpc - 000801_New.esp.json"],
            changes.Documents.Select(document => Path.GetRelativePath(PluginSourceRoot.In(_modFolder, "New.esp"), Path.Combine(_modFolder, document.Path)).Replace('\\', '/')).Order(StringComparer.Ordinal));
    }

    [Fact]
    public void ChangesToRenameSource_ToANameWithAnUppercaseExtension_LeaveTheHeaderWhereTheLayoutLooksForIt()
    {
        var renamed = Old with { Name = "New.ESM" };

        Rename(renamed.Name);

        var documents = TreeDocuments.Of(Repository, renamed);
        Assert.Contains(documents, d => d.RecordType == PluginHeader.RecordType);
        Assert.Contains(
            Repository.TreeOf(renamed).Value().Files,
            file => file.RelativePath == "RecordData.json");
    }

    [Fact]
    public void ChangesToRenameSource_ReadAnUnsavedTextInPlaceOfItsFile()
    {
        var self = Path.Combine(PluginSourceRoot.In(_modFolder, Old.Name), "Npcs", "SelfNpc - 000801_Old.esp.json");

        Rename("New.esp", [new DocumentChange(self, """{"FormKey":"000801:Old.esp","Name":"Unsaved"}""")]);

        Assert.Equal(
            """{"FormKey":"000801:New.esp","Name":"Unsaved"}""",
            File.ReadAllText(Path.Combine(PluginSourceRoot.In(_modFolder, "New.esp"), "Npcs", "SelfNpc - 000801_New.esp.json")));
    }

    [Fact]
    public void ChangesToRenameSource_AnswerAnUnsavedTextTheRenameLeavesAsItIs_SoItIsSavedAtItsNewPath()
    {
        var metadata = Path.Combine(PluginSourceRoot.In(_modFolder, Old.Name), "Cells", "0", "0", "GroupRecordData.json");
        var changes = Session(new DocumentChange(metadata, """{"unsaved":true}""")).Repository.ChangesToRenameSource(Old, "New.esp").Value().Require();

        var document = Assert.Single(changes.Documents, document => document.Path.EndsWith("GroupRecordData.json", StringComparison.Ordinal));
        Assert.Equal("""{"unsaved":true}""", document.Text);
    }

    [Fact]
    public void MoveLastWrittenTo_MovesWhatModbenchLastWroteToTheNewName()
    {
        Assert.Null(Repository.MoveLastWrittenTo(Old.Name, "New.esp"));

        Assert.Equal([LastWritten], Repository.LastWrittenBinarySha256s(Old with { Name = "New.esp" }).Value());
        Assert.Empty(Repository.LastWrittenBinarySha256s(Old).Value());
    }

    [Fact]
    public void MoveLastWrittenTo_AfterTheTreeMoved_MovesTheRefTheTreeWasWrittenUnder()
    {
        Rename("New.esp");

        Assert.Null(Repository.MoveLastWrittenTo(Old.Name, "New.esp"));

        Assert.Equal([LastWritten], Repository.LastWrittenBinarySha256s(Old with { Name = "New.esp" }).Value());
    }

    [Theory]
    [InlineData("OTHER.esp")]
    [InlineData("OLD.ESP")]
    public void ChangesToRenameSource_ToANameThatAPluginSourceHoldsComparedWithoutCase_AnswerNone(string taken)
    {
        Assert.Null(Repository.ChangesToRenameSource(Old, taken).Value());
    }

    [Fact]
    public void ChangesToRenameSource_OfATreeWhoseGroupMetadataIsNoJson_RefuseNamingIt_WithoutCallingItARecord()
    {
        var broken = Path.Combine(PluginSourceRoot.In(_modFolder, Old.Name), "Cells", "0", "0", "GroupRecordData.json");
        File.WriteAllText(broken, "{");

        var refused = Assert.IsType<SourceFailure.Unreadable>(Repository.ChangesToRenameSource(Old, "New.esp").Stopped());

        Assert.Equal(Path.GetRelativePath(_modFolder, broken), refused.File?.SourceRelativePath);
        Assert.DoesNotContain("filed as a record", refused.Reason, StringComparison.Ordinal);
    }

    [Fact]
    public void ChangesToRenameSource_OfATreeHoldingADocumentThatIsNoJson_RefuseNamingIt()
    {
        const string text = """{ "FormKey": "000801:Old.esp", """;
        var broken = Path.Combine(PluginSourceRoot.In(_modFolder, Old.Name), "Npcs", "SelfNpc - 000801_Old.esp.json");
        File.WriteAllText(broken, text);

        var refused = Assert.IsType<SourceFailure.Unreadable>(Repository.ChangesToRenameSource(Old, "New.esp").Stopped());

        Assert.Equal(Path.GetRelativePath(_modFolder, broken), refused.File?.SourceRelativePath);
    }

    [Fact]
    public void MoveLastWrittenTo_WhenGitRefusesToMoveIt_PutsNothingBack_AndTheOldRefStays()
    {
        LastWriteRecord.RefuseRecordingUnder(_modFolder, "New.esp");

        Assert.IsType<SourceFailure.GitFailed>(Repository.MoveLastWrittenTo(Old.Name, "New.esp"));

        Assert.Equal([LastWritten], Repository.LastWrittenBinarySha256s(Old).Value());
    }

    private bool Rename(string newName, IReadOnlyList<DocumentChange>? unsaved = null)
    {
        var session = Session([.. unsaved ?? []]);
        if (session.Repository.ChangesToRenameSource(Old, newName).Value() is not { } changes) return false;
        Assert.Null(session.Atomically(() => session.Apply(SourceAnswer.Of(changes))));
        EditSaving.Save(
            session.Changes.Moves.Select(move => (move.From, move.To)), session.Changes.Deletions,
            session.Changes.Documents.Select(document => (document.Path, document.Text)));
        return true;
    }

    private SourceRepository Repository => SourceRepository.Open(TestMod.In(_modFolder), GameRelease.Fallout4).Require();

    private WriteSession Session(params DocumentChange[] held) => WriteSession.Over(TestMod.In(_modFolder), GameRelease.Fallout4, held);

    private static List<TreeFile> Files(IEnumerable<(string Path, string Text)> tree) =>
        [.. tree.Select(file => new TreeFile(file.Path, Encoding.UTF8.GetBytes(file.Text)))];

    private (string Path, string Text)[] TreeOf(string plugin)
    {
        var root = PluginSourceRoot.In(_modFolder, plugin);
        return [.. Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories)
            .Select(path => (Path.GetRelativePath(root, path).Replace('\\', '/'), File.ReadAllText(path)))
            .OrderBy(file => file.Item1, StringComparer.Ordinal)];
    }

    private string[] PluginSources() =>
        [.. Directory.EnumerateDirectories(Path.Combine(_modFolder, "plugin-source")).Select(Path.GetFileName).OfType<string>().Order(StringComparer.Ordinal)];

    private string Git(params string[] args) => GitProbe.Run(Path.Combine(_modFolder, ".git"), _modFolder, args);
}
