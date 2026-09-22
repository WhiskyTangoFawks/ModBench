using System.Text.Json;
using MEditService.Commands;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.SourceRepo;
using MEditService.TestSupport;
using MEditService.TestSupport.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using static MEditService.Commands.Tests.TestSupport.Envelopes;

namespace MEditService.Commands.Tests.Edits;

/// <summary>Read back by property name, not position: a script's properties are a keyed array
/// stored in name order rather than payload order.</summary>
public sealed class ConcreteBaseUnionEditTests : IDisposable
{
    private readonly ScriptedNpcFixture _fixture = new();

    public void Dispose() => _fixture.Dispose();

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    // The adapter under test, spelled once: only the property's leaf changes between the two
    // writes, the way the editor's own resend does — Data rides along into the second write.
    private static JsonElement Adapter(string leaf) => Json($$"""
        {"Version": 6, "ObjectFormat": 2, "Scripts": [
          {"Name": "TestScript", "Flags": "Local", "Properties": [
            {"MutagenObjectType": "{{leaf}}", "Name": "Switched", "Flags": "Removed", "Data": 42},
            {"MutagenObjectType": "ScriptStringProperty", "Name": "Sibling", "Flags": "Edited", "Data": "kept"}
          ]}
        ]}
        """);

    [Fact]
    public void SwitchingAScriptPropertyLeaf_KeepsSharedMembers_DefaultsItsOwn_AndLeavesTheSiblingAlone()
    {
        var setUp = _fixture.Service().Set(
            _fixture.Plugin, _fixture.Npc.ToString(), "VirtualMachineAdapter", Adapter("ScriptIntProperty"));
        Assert.True(setUp.Applied, setUp.Message);
        var before = WrittenProperties(_fixture.NpcBody());
        Assert.Equal("ScriptIntProperty", before["Switched"].GetProperty("MutagenObjectType").GetString());
        Assert.Equal(42, before["Switched"].GetProperty("Data").GetInt32());

        var result = _fixture.Service().Set(
            _fixture.Plugin, _fixture.Npc.ToString(), "VirtualMachineAdapter", Adapter("ScriptFloatProperty"));

        Assert.True(result.Applied, result.Message);
        var after = WrittenProperties(_fixture.NpcBody());
        var switched = after["Switched"];
        Assert.Equal("ScriptFloatProperty", switched.GetProperty("MutagenObjectType").GetString());
        Assert.Equal("Switched", switched.GetProperty("Name").GetString());
        Assert.Equal("Removed", switched.GetProperty("Flags").GetString());
        // Data is one member across the leaves, so the value posted with the switch lands as the
        // incoming leaf's own Data, converted to its type.
        Assert.Equal(42f, switched.GetProperty("Data").GetSingle());
        Assert.Equal(before["Sibling"].GetRawText(), after["Sibling"].GetRawText());
    }

    // The base leaf declares no Data, so the discriminator gesture's cascade drops it.
    [Fact]
    public void SwitchingToTheBaseLeaf_BuildsABareScriptProperty()
    {
        var setUp = _fixture.Service().Set(
            _fixture.Plugin, _fixture.Npc.ToString(), "VirtualMachineAdapter", Adapter("ScriptIntProperty"));
        Assert.True(setUp.Applied, setUp.Message);

        var result = _fixture.Service().Edit(
            _fixture.Plugin, _fixture.Npc.ToString(),
            SetAt(Json("\"ScriptProperty\""),
                Member("VirtualMachineAdapter"), Member("Scripts"), Key("TestScript"), Member("Properties"), Key("Switched"), Member("MutagenObjectType")));

        Assert.True(result.Applied, result.Message);
        var written = WrittenProperties(_fixture.NpcBody())["Switched"];
        Assert.Equal("ScriptProperty", written.GetProperty("MutagenObjectType").GetString());
        Assert.Equal("Switched", written.GetProperty("Name").GetString());
        Assert.False(written.TryGetProperty("Data", out _));
    }

    [Fact]
    public void ScriptPropertyWithoutDiscriminator_IsRefusedAndWritesNothing()
    {
        var before = _fixture.NpcBody();

        var result = _fixture.Service().Set(
            _fixture.Plugin, _fixture.Npc.ToString(), "VirtualMachineAdapter",
            Json("""
                {"Version": 6, "ObjectFormat": 2, "Scripts": [{"Name": "S", "Flags": "Local",
                 "Properties": [{"Name": "P", "Flags": "Edited", "Data": 1}]}]}
                """));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.DiscriminatorInvalid, result.Refusal);
        Assert.Equal(before, _fixture.NpcBody());
    }

    private static Dictionary<string, JsonElement> WrittenProperties(string body) =>
        JsonDocument.Parse(body).RootElement.GetProperty("VirtualMachineAdapter")
            .GetProperty("Scripts")[0].GetProperty("Properties").EnumerateArray()
            .ToDictionary(p => p.GetProperty("Name").GetString().Require(), StringComparer.Ordinal);

    private sealed class ScriptedNpcFixture : IDisposable
    {
        private const string PluginName = "ScriptedNpc701.esp";
        private const string Origin = "ScriptedNpc701Mod";

        private readonly string _modFolder = Directory.CreateTempSubdirectory("medit-701-mod-").FullName;
        private readonly string _gameDirectory = Directory.CreateTempSubdirectory("medit-701-game-").FullName;

        public PluginCopyKey Plugin { get; } = new(PluginName, Origin);
        public LoadOrderSnapshot LoadOrder { get; }
        public EditRecordHandler EditHandler { get; }
        public FormKey Npc { get; }

        public ScriptedNpcFixture()
        {
            var holder = new LoadOrderHolder();
            var pluginPath = Path.Combine(_modFolder, PluginName);
            var mod = new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);

            var npc = new Npc(mod.GetNextFormKey("Npc701"), Fallout4Release.Fallout4)
            {
                EditorID = "Npc701",
                VirtualMachineAdapter = new VirtualMachineAdapter
                {
                    Version = 6,
                    ObjectFormat = 2,
                    Scripts = [new ScriptEntry { Name = "TestScript", Properties = [new ScriptIntProperty { Name = "Original", Data = 1 }] }],
                },
            };
            mod.Npcs.Add(npc);
            Npc = npc.FormKey;

            mod.WriteToBinary(pluginPath);

            LoadOrder = new LoadOrderSnapshot(
                _gameDirectory, _gameDirectory, GameRelease.Fallout4,
                SnapshotCopies.Of([new LoadOrderEntry(PluginName, pluginPath, Origin, Slot: 0, Enabled: true, Winning: true)]));
            new TrackService(NullLogger<TrackService>.Instance, TestAdapters.Mutagen())
                .TrackAsync(LoadOrder, Origin, SourcePreset.Edits)
                .GetAwaiter().GetResult();

            holder.Apply(LoadOrder);
            EditHandler = TestEditService.EditHandler(holder);
        }

        public EditRecordHandler Service() => EditHandler;

        public string NpcBody() => TrackedTree.Body(_modFolder, Plugin, Npc.ToString());

        public void Dispose()
        {
            TryDelete(_modFolder);
            TryDelete(_gameDirectory);
        }

        private static void TryDelete(string path)
        {
            try { Directory.Delete(path, recursive: true); }
            catch (IOException) { /* scratch directory, best effort */ }
            catch (UnauthorizedAccessException) { /* ditto */ }
        }
    }
}
