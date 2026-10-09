using System.Text;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceAdapter.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.SourceAdapter.Tests.Source;

public sealed class SourceRepositoryFileOfARecordTests : IDisposable
{
    private const string PluginName = "Filed.esp";
    private const string Origin = "FiledMod";
    private static readonly PluginAddress Plugin = new(PluginName, Origin);
    private static readonly GameRelease Release = GameRelease.Fallout4;
    private static readonly RecordIdentity Npc = new("000800:Filed.esp", "npc_", "FiledNpc");
    private static readonly RecordIdentity Room = new("000801:Filed.esp", "cell", "FiledRoom");
    private static readonly RecordIdentity Placed = new("000802:Filed.esp", "refr", "FiledRef");
    private static readonly RecordIdentity Header = new("000000:Filed.esp", PluginHeader.RecordType, EditorId: null);

    private static readonly string NpcDocument = Path.Combine(PluginSourceRoot.For(PluginName), "Npcs", "FiledNpc - 000800_Filed.esp.json");
    private static readonly string RoomDocument = PluginSourceRoot.ContainerDocument(
        Path.Combine(PluginSourceRoot.For(PluginName), "Cells", "0", "0", "FiledRoom - 000801_Filed.esp"));
    private static readonly string GroupMetadata = Path.Combine(PluginSourceRoot.For(PluginName), "Cells", "GroupRecordData.json");

    private readonly ScratchDirectory _modFolder = new("medit-file-of-a-record-");

    public SourceRepositoryFileOfARecordTests() => TrackFiledIn(_modFolder);

    public void Dispose() => _modFolder.Dispose();

    private static void TrackFiledIn(string modFolder) =>
        PluginBaselines.Track(modFolder, [
            new TreeFile(PluginSourceRoot.HeaderDocument(PluginName), "{\"MasterReferences\": []}"u8.ToArray()),
            new TreeFile(NpcDocument, "{\"FormKey\": \"000800:Filed.esp\", \"EditorID\": \"FiledNpc\"}"u8.ToArray()),
            new TreeFile(GroupMetadata, "{}"u8.ToArray()),
            new TreeFile(RoomDocument, RoomText()),
        ]);

    private static byte[] RoomText()
    {
        var room = new Cell(FormKey.Factory(Room.FormKey), Fallout4Release.Fallout4) { EditorID = Room.EditorId };
        room.Temporary.Add(new PlacedObject(FormKey.Factory(Placed.FormKey), Fallout4Release.Fallout4) { EditorID = Placed.EditorId });
        return Encoding.UTF8.GetBytes(RecordTextCodec.SerializeToText(room, Release));
    }

    private string NpcFile => Path.Combine(_modFolder, NpcDocument);

    private string RoomFile => Path.Combine(_modFolder, RoomDocument);

    private string HeaderFile => Path.Combine(_modFolder, PluginSourceRoot.HeaderDocument(PluginName));

    private SourceRepository Repository =>
        SourceRepository.Open(new PluginProvider.FromMod(Origin, _modFolder), Release)
        ?? throw new InvalidOperationException($"Expected '{_modFolder}' to already be tracked.");

    private static LoadOrderEntry Entry(string modFolder, string origin) =>
        new(PluginName, Path.Combine(modFolder, PluginName), origin, Line: 0, Enabled: true, Winning: true);

    private LoadOrderSnapshot LoadOrder(params LoadOrderEntry[] plugins) =>
        SnapshotPlugins.Snapshot(_modFolder, null, Release, plugins.Length == 0 ? [Entry(_modFolder, Origin)] : plugins);

    private RecordAt RecordOf(string path, LoadOrderSnapshot? loadOrder = null) =>
        Assert.IsType<RecordOfFileAnswer.Holds>(new GitSourceAdapter(new UnsavedDocuments()).RecordOfFile(loadOrder ?? LoadOrder(), path)).Record;

    private string WhyRefused(string path, LoadOrderSnapshot? loadOrder = null) =>
        Assert.IsType<RecordOfFileAnswer.Refused>(new GitSourceAdapter(new UnsavedDocuments()).RecordOfFile(loadOrder ?? LoadOrder(), path)).Why;

    private string RenameNpcFileByHand()
    {
        var renamed = Path.Combine(Path.GetDirectoryName(NpcFile).Require(), "Named By Hand.json");
        File.Move(NpcFile, renamed);
        return renamed;
    }

    [Fact]
    public void ARecord_IsInItsOwnDocument()
    {
        Assert.Equal(NpcFile, Repository.DocumentOf(Plugin, Npc).Value()?.Path);
    }

    [Fact]
    public void ThePluginHeaderRecord_IsInTheRootHeaderDocument()
    {
        Assert.Equal(HeaderFile, Repository.DocumentOf(Plugin, Header).Value()?.Path);
    }

    [Fact]
    public void AContainerRecord_IsInItsOwnDocument()
    {
        Assert.Equal(RoomFile, Repository.DocumentOf(Plugin, Room).Value()?.Path);
    }

    [Fact]
    public void AChildRecord_IsInTheDocumentOfTheRecordCarryingIt()
    {
        Assert.Equal(RoomFile, Repository.DocumentOf(Plugin, Placed).Value()?.Path);
    }

    [Fact]
    public void AChildRecordsDocument_IsItsContainers()
    {
        Assert.True(Repository.DocumentOf(Plugin, Placed).Value()?.IsContainersDocument);
    }

    [Fact]
    public void ARecordsOwnDocument_IsNotItsContainers()
    {
        Assert.False(Repository.DocumentOf(Plugin, Npc).Value()?.IsContainersDocument);
        Assert.False(Repository.DocumentOf(Plugin, Room).Value()?.IsContainersDocument);
        Assert.False(Repository.DocumentOf(Plugin, Header).Value()?.IsContainersDocument);
    }

    [Fact]
    public void ARecord_IsInItsFile_WhateverItWasRenamedTo()
    {
        var renamed = RenameNpcFileByHand();

        Assert.Equal(renamed, Repository.DocumentOf(Plugin, Npc).Value()?.Path);
    }

    [Fact]
    public void ARecordWhoseFileIsGone_IsInNoFile()
    {
        File.Delete(NpcFile);

        Assert.Null(Repository.DocumentOf(Plugin, Npc).Value()?.Path);
    }

    [Fact]
    public void ARecordsOwnDocument_HoldsThatRecord()
    {
        Assert.Equal(new RecordAt(Plugin, Npc.FormKey), RecordOf(NpcFile));
    }

    [Fact]
    public void ADocumentHeldUnsaved_HoldsTheRecordItsUnsavedTextDeclares()
    {
        var unsaved = new UnsavedDocuments();
        unsaved.Apply([new DocumentChange(NpcFile, "{\"FormKey\": \"000900:Filed.esp\", \"EditorID\": \"FiledNpc\"}")]);

        var answer = new GitSourceAdapter(unsaved).RecordOfFile(LoadOrder(), NpcFile);

        Assert.Equal(new RecordAt(Plugin, "000900:Filed.esp"), Assert.IsType<RecordOfFileAnswer.Holds>(answer).Record);
    }

    [Fact]
    public void TheRootHeaderDocument_HoldsThePluginHeaderRecord()
    {
        Assert.Equal(new RecordAt(Plugin, Header.FormKey), RecordOf(HeaderFile));
    }

    [Fact]
    public void AContainersDocument_HoldsTheContainer_NotAChildItCarries()
    {
        Assert.Equal(new RecordAt(Plugin, Room.FormKey), RecordOf(RoomFile));
    }

    [Fact]
    public void AFileRenamedByHand_HoldsTheRecordItsTextDeclares()
    {
        var renamed = RenameNpcFileByHand();

        Assert.Equal(new RecordAt(Plugin, Npc.FormKey), RecordOf(renamed));
    }

    [Fact]
    public void AFileInTheSourceOfOneOfTwoPluginsOfOneName_HoldsThatPluginsRecord()
    {
        using var other = new ScratchDirectory("medit-file-of-a-record-other-");
        TrackFiledIn(other);

        var record = RecordOf(
            Path.Combine(other, NpcDocument), LoadOrder(Entry(_modFolder, Origin), Entry(other, "OtherMod") with { Winning = false }));

        Assert.Equal(new PluginAddress(PluginName, "OtherMod"), record.Plugin);
    }

    [Fact]
    public void APathUnderNoPluginsSource_IsRefused()
    {
        var document = Path.Combine(_modFolder, "Loose.json");

        Assert.Equal($"{document} is under no tracked plugin's source.", WhyRefused(document));
    }

    [Fact]
    public void ASourceInAModTheLoadOrderDoesNotName_IsRefused()
    {
        using var other = new ScratchDirectory("medit-file-of-a-record-unlisted-");
        TrackFiledIn(other);
        var npcFile = Path.Combine(other, NpcDocument);

        Assert.Equal($"{npcFile} is under no tracked plugin's source.", WhyRefused(npcFile));
    }

    [Fact]
    public void ASourceInAModWithNoRepository_IsRefused()
    {
        using var untracked = new ScratchDirectory("medit-file-of-a-record-untracked-");
        var npcFile = Path.Combine(untracked, NpcDocument);
        Directory.CreateDirectory(Path.GetDirectoryName(npcFile).Require());
        File.WriteAllText(npcFile, "{\"FormKey\": \"000800:Filed.esp\", \"EditorID\": \"FiledNpc\"}");

        Assert.Equal(
            $"{npcFile} is under no tracked plugin's source.",
            WhyRefused(npcFile, LoadOrder(Entry(_modFolder, Origin) with { Winning = false }, Entry(untracked, "UntrackedMod"))));
    }

    [Fact]
    public void AGroupsMetadataFile_HoldsNoRecord()
    {
        Assert.IsType<RecordOfFileAnswer.HoldsNone>(new GitSourceAdapter(new UnsavedDocuments()).RecordOfFile(LoadOrder(), Path.Combine(_modFolder, GroupMetadata)));
    }

    [Fact]
    public void AGroupsMetadataFile_HoldsNoRecord_UnderASourceTheLoadOrderDoesNotName()
    {
        using var other = new ScratchDirectory("medit-file-of-a-record-unlisted-");
        TrackFiledIn(other);

        Assert.IsType<RecordOfFileAnswer.HoldsNone>(new GitSourceAdapter(new UnsavedDocuments()).RecordOfFile(LoadOrder(), Path.Combine(other, GroupMetadata)));
    }

    [Fact]
    public void AFileThatIsNoJsonDocument_HoldsNoRecord_WhateverItsText()
    {
        var notes = Path.Combine(PluginSourceRoot.For(PluginName), "Npcs", "notes.txt");
        File.WriteAllText(Path.Combine(_modFolder, notes), "{\"FormKey\": \"000900:Filed.esp\"}");

        Assert.IsType<RecordOfFileAnswer.HoldsNone>(new GitSourceAdapter(new UnsavedDocuments()).RecordOfFile(LoadOrder(), Path.Combine(_modFolder, notes)));
    }

    [Fact]
    public void AFileWhoseTextIsNoRecordDocument_IsRefused_InTheReadersWords()
    {
        File.WriteAllText(NpcFile, "[1, 2]");

        Assert.Equal($"{NpcFile} is no record document: its root is not a JSON object.", WhyRefused(NpcFile));
    }

    [Fact]
    public void AFileThatIsGone_IsRefused()
    {
        File.Delete(NpcFile);

        Assert.Equal($"{NpcFile} could not be read.", WhyRefused(NpcFile));
    }

    [Fact]
    public void ADocumentDeclaringNoFormKey_IsRefused()
    {
        File.WriteAllText(NpcFile, "{\"EditorID\": \"FiledNpc\"}");

        Assert.Equal($"{NpcFile} declares no FormKey, so it is no record's document.", WhyRefused(NpcFile));
    }
}
