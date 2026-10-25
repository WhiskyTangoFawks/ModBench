using MEditService.LoadOrder;
using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog;

namespace MEditService.RecordIndex.Tests.Records;

public sealed class ValidateByStampsTests : IDisposable
{
    private readonly ScatteredFixtureData _fixture;
    private readonly LoadOrderEntry _mod;
    private readonly LoadOrderEntry _partner;
    private readonly InMemoryNotificationPublisher _notifications = new();
    private readonly OpenedIndex _index;
    private readonly string _npc;

    public ValidateByStampsTests()
    {
        FormKey npc = default;
        _fixture = new PluginFixtureBuilder("validate-by-stamps")
            .WithPlugin("Fixture.esp", mod =>
            {
                npc = mod.Npcs.AddNew("FixtureNpc").FormKey;
                var subBlock = new WorldspaceSubBlock { BlockNumberX = 0, BlockNumberY = 0 };
                subBlock.Items.Add(new Cell(mod) { EditorID = "ExteriorCell", Grid = new CellGrid { Point = new P2Int(3, 4) } });
                var block = new WorldspaceBlock { BlockNumberX = 0, BlockNumberY = 0 };
                block.Items.Add(subBlock);
                var world = new Worldspace(mod) { EditorID = "FixtureWorld" };
                world.SubCells.Add(block);
                mod.Worldspaces.Add(world);
            }, origin: "FixtureMod")
            .WithPlugin("Partner.esp", mod => mod.Npcs.AddNew("PartnerNpc"), origin: "PartnerMod")
            .BuildScattered()
            .CompiledPlugin();
        _mod = _fixture.Plugins.Single(p => p.Name == "Fixture.esp");
        _partner = _fixture.Plugins.Single(p => p.Name == "Partner.esp");
        _npc = npc.ToString();
        _index = Indexes.Reconciled(_fixture, notifications: _notifications);
    }

    public void Dispose()
    {
        _index.Dispose();
        _fixture.Dispose();
    }

    private RecordDetail Npc => _index.DocumentOf(_npc, _mod.Key);

    private WorkingTreeState NpcState =>
        _index.RowOf(_npc, _mod.Key)?.WorkingTreeState ?? throw new InvalidOperationException($"Expected {_npc} to be listed.");

    private void ValidateUntilEditorId(string editorId) =>
        _index.NextSnapshotUntil(() => NpcNamed(editorId), $"the record named {editorId}");

    private bool NpcNamed(string editorId) =>
        _index.Queries.GetCompareRecords([new RecordCopy(_npc, _mod.Key)]).Holds(out var answer, out _)
        && answer.Compare is { } compare
        && compare.Overrides.Single().EditorId == editorId;

    private void ValidateUntilSourceUnreadable() =>
        _index.NextSnapshotUntil(() => _index.ReadFromItsPluginFileForItsUnreadableSource(_mod.Key), "the plugin file read in place of its source");

    private string NpcFile => _mod.SourceFileOf(Npc);

    private string ModRelativePath(string file) => Path.GetRelativePath(_mod.ModFolderOf(), file).Replace('\\', '/');

    [Fact]
    public void ADirtyDocumentUnchangedSinceTheLastValidation_IsNotAnnouncedAgain()
    {
        _mod.HandEdit(Npc, "\"FixtureNpc\"", "\"RenamedByHand\"");
        _index.NextSnapshot();

        var announced = _index.AnnouncedByEqualArrivals(_notifications, () => _partner.RenamedByHand(_index));

        Assert.DoesNotContain(announced, Announcements.RowsChanged(_npc));
        Assert.DoesNotContain(announced, Announcements.PluginChanged(_mod));
    }

    [Fact]
    public void AnExteriorCellsDocument_IsADocumentTheRowsWereDerivedFrom_SoAQuietValidationLeavesItsPluginAlone()
    {
        var announced = _index.AnnouncedByEqualArrivals(_notifications, () => _partner.RenamedByHand(_index));

        Assert.DoesNotContain(announced, Announcements.PluginChanged(_mod));
    }

    [Fact]
    public void AHandEditOfTheSameLengthThatKeepsTheModificationTime_IsStillFound()
    {
        var file = NpcFile;
        var modified = File.GetLastWriteTimeUtc(file);
        File.WriteAllText(file, File.ReadAllText(file).Replace("\"FixtureNpc\"", "\"FixtureNpX\"", StringComparison.Ordinal));
        File.SetLastWriteTimeUtc(file, modified);

        ValidateUntilEditorId("FixtureNpX");

        Assert.Equal("FixtureNpX", Npc.EditorId);
    }

    [Fact]
    public void AHandEditThatIsRestored_ReturnsTheRecordToHead()
    {
        _mod.HandEdit(Npc, "\"FixtureNpc\"", "\"RenamedByHand\"");
        ValidateUntilEditorId("RenamedByHand");
        _mod.Git("checkout", "--", ModRelativePath(NpcFile));

        ValidateUntilEditorId("FixtureNpc");

        Assert.Equal(WorkingTreeState.None, NpcState);
        Assert.Equal("FixtureNpc", Npc.EditorId);
    }

    [Theory]
    [InlineData("{0}")]
    [InlineData("RenamedByHand.json")]
    [InlineData("SortedByHand/{0}")]
    public void ADeletedDocumentWrittenBackByHand_ComesBack(string writtenTo)
    {
        var file = NpcFile;
        var text = File.ReadAllText(file);
        File.Delete(file);
        _index.NextSnapshotUntil(() => _index.CopyIn(_npc, _mod.Key) is null, "the record gone");
        File.WriteAllText(AnotherTool.Beside(file, writtenTo), text);

        ValidateUntilEditorId("FixtureNpc");

        Assert.Equal("FixtureNpc", Npc.EditorId);
        Assert.Equal(WorkingTreeState.None, NpcState);
    }

    [Fact]
    public void AnUncommittedDocumentDeletedByHand_LosesItsRows()
    {
        const string created = "000900:Fixture.esp";
        _index.Create(_mod, created, "npc_", "CreatedNpc",
            _index.BodyOf(_npc, _mod.Key)
                .Replace(_npc, created, StringComparison.Ordinal)
                .Replace("\"FixtureNpc\"", "\"CreatedNpc\"", StringComparison.Ordinal));
        File.Delete(_mod.SourceFileOf(_index.DocumentOf(created, _mod.Key)));

        _index.NextSnapshot();

        Assert.Null(_index.CopyIn(created, _mod.Key));
    }

    [Fact]
    public void ADocumentThatCouldNotBeRead_IsRefreshedByTheNextValidation()
    {
        _mod.HandEdit(Npc, "\"FixtureNpc\"", "\"RenamedByHand\"");
        _index.NextSnapshot();
        Assert.Equal(WorkingTreeState.Modified, NpcState);
        using (new FileStream(NpcFile, FileMode.Open, FileAccess.Read, FileShare.None))
            ValidateUntilSourceUnreadable();
        Assert.Equal("FixtureNpc", Npc.EditorId);

        _index.NextSnapshot();

        Assert.Equal("RenamedByHand", Npc.EditorId);
    }

    [Fact]
    public void ATreeThatReturns_ReplacesTheBinarysRows()
    {
        _mod.HandEdit(Npc, "\"FixtureNpc\"", "\"RenamedByHand\"");
        _index.NextSnapshot();
        var treeThatLeavesAndReturns = PluginSourceRoot.In(_mod.ModFolderOf(), _mod.Name);
        Directory.Move(treeThatLeavesAndReturns, treeThatLeavesAndReturns + ".away");
        ValidateUntilEditorId("FixtureNpc");
        Directory.Move(treeThatLeavesAndReturns + ".away", treeThatLeavesAndReturns);

        ValidateUntilEditorId("RenamedByHand");

        Assert.Equal("RenamedByHand", Npc.EditorId);
    }

    [Fact]
    public void AStagedRenameOfADocument_LeavesItsRecordUnchanged()
    {
        var document = NpcFile;
        var renamed = Path.Combine(Path.GetDirectoryName(document).Require(), Path.GetFileName(document).Replace("FixtureNpc - ", "Renamed - ", StringComparison.Ordinal));
        _mod.Git("mv", ModRelativePath(document), ModRelativePath(renamed));

        using var index = Indexes.Reconciled(_fixture);

        Assert.Equal(WorkingTreeState.None, index.ListedIn(_mod.Key).Single(i => i.FormKey == _npc).WorkingTreeState);
    }

    [Theory]
    [InlineData("RenamedByHand.json")]
    [InlineData("SortedByHand/{0}")]
    public void ADocumentMovedByHand_KeepsItsRecord_AndAnnouncesNoChangeToIt(string movedTo)
    {
        var document = NpcFile;
        File.Move(document, AnotherTool.Beside(document, movedTo));

        var announced = _index.AnnouncedByEqualArrivals(_notifications, () => _partner.RenamedByHand(_index));

        Assert.Equal("FixtureNpc", Npc.EditorId);
        Assert.DoesNotContain(announced, Announcements.RowsChanged(_npc));
    }

    [Theory]
    [InlineData("RenamedByHand.json", "{0}")]
    [InlineData("Misnamed - 000900_Fixture.esp.json", "{0}")]
    [InlineData("Twin - 000800_Fixture.esp.json", "{0}")]
    [InlineData("SortedByHand/{0}", "{0}")]
    [InlineData("SortedByHand/RenamedByHand.json", "{0}")]
    [InlineData("Backup/{0}", "Backup/{0}")]
    [InlineData("Backup/copy.json", "Backup/copy.json")]
    public void ACopyOfADocument_IsDiagnosedNamingBothUntilOneOfTheTwoIsDeleted_AndTheRecordSurvives(string copiedTo, string deleted)
    {
        var document = NpcFile;
        Directory.CreateDirectory(AnotherTool.Beside(document, "Backup"));
        var partnerRenamed = _partner.RenamedByHand(_index);
        _index.NextSnapshotUntil(() => _notifications.Notifications.Any(n => partnerRenamed(n)), "the partner's change");
        var copy = AnotherTool.Beside(document, copiedTo);
        File.Copy(document, copy);

        ValidateUntilSourceUnreadable();

        var problems = _index.Queries.GetProblems().Value().Single(p => PluginAddress.Comparer.Equals(p.Plugin, _mod.Key));
        Assert.Equivalent(
            new[] { Path.GetRelativePath(_mod.ModFolderOf(), document), Path.GetRelativePath(_mod.ModFolderOf(), copy) },
            problems.Problems.Select(p => p.SourceRelativePath),
            strict: true);

        File.Delete(AnotherTool.Beside(document, deleted));
        _index.NextSnapshotUntil(() => !_index.ReadFromItsPluginFileForItsUnreadableSource(_mod.Key), "the plugin read from its source again");

        Assert.Equal("FixtureNpc", Npc.EditorId);
    }

    [Fact]
    public void ValidatingEveryPlugin_WhenOnePluginsTreeCannotBeRead_StillValidatesTheOthers()
    {
        FormKey other = default;
        using var fixture = new PluginFixtureBuilder("validate-two-compiled-plugin")
            .WithPlugin("Broken.esp", mod => mod.Npcs.AddNew("BrokenNpc"), origin: "BrokenMod")
            .WithPlugin("Sound.esp", mod => other = mod.Npcs.AddNew("SoundNpc").FormKey, origin: "SoundMod")
            .BuildScattered()
            .CompiledPlugin();
        using var index = Indexes.Reconciled(fixture);
        var broken = fixture.Plugins.Single(p => p.Name == "Broken.esp");
        var sound = fixture.Plugins.Single(p => p.Name == "Sound.esp");
        var brokenDocument = broken.SourceFileOf(index.DocumentOf(index.ListedIn(broken.Key).Single().FormKey, broken.Key));
        var backup = Path.Combine(Directory.CreateDirectory(Path.Combine(Path.GetDirectoryName(brokenDocument).Require(), "Backup")).FullName, Path.GetFileName(brokenDocument));
        File.Copy(brokenDocument, backup);
        sound.HandEdit(index.DocumentOf(other.ToString(), sound.Key), "\"SoundNpc\"", "\"EditedSoundNpc\"");

        index.NextSnapshotUntil(
            () => index.ReadFromItsPluginFileForItsUnreadableSource(broken.Key),
            "the broken plugin's file read in place of its source");

        Assert.Equal("EditedSoundNpc", index.DocumentOf(other.ToString(), sound.Key).EditorId);
    }

}
