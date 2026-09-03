using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Edits;

/// <summary>
/// #701, the write half: a script property is a union over a concrete base, so switching its
/// leaf is the same ordinary edit of the enclosing array #688 made it for an abstract one —
/// members the incoming leaf shares are kept, its own members start at defaults, the outgoing
/// leaf's own members are dropped. VMAD is reflected here only because the fixture's reflector
/// lifts the shipped exclusion; the edit lands through <c>RecordEditService</c> as a real Mutagen
/// binary write and re-parse, and is read back off the written document's own text.
/// </summary>
public sealed class ConcreteBaseUnionEditTests : IDisposable
{
    private readonly ScriptedNpcFixture _fixture = new();

    public void Dispose() => _fixture.Dispose();

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    // The adapter under test, spelled once: only the property's leaf changes between the two
    // writes, the way the editor's own resend does — data_int rides along into the second write.
    private static JsonElement Adapter(string leaf) => Json($$"""
        {"version": 6, "object_format": 2, "scripts": [
          {"name": "TestScript", "flags": "Local", "properties": [
            {"concrete_type": "{{leaf}}", "name": "Switched", "flags": "Removed", "data_int": 42},
            {"concrete_type": "ScriptStringProperty", "name": "Sibling", "flags": "Edited", "data_string": "kept"}
          ]}
        ]}
        """);

    [Fact]
    public void SwitchingAScriptPropertyLeaf_KeepsSharedMembers_DefaultsItsOwn_AndLeavesTheSiblingAlone()
    {
        var setUp = _fixture.Service().EditField(
            _fixture.Plugin, _fixture.Npc.ToString(), "virtual_machine_adapter", Adapter("ScriptIntProperty"));
        Assert.True(setUp.Applied, setUp.Message);
        var before = WrittenProperties(_fixture.NpcBody());
        Assert.Equal("ScriptIntProperty", before[0].GetProperty("MutagenObjectType").GetString());
        Assert.Equal(42, before[0].GetProperty("Data").GetInt32());

        var result = _fixture.Service().EditField(
            _fixture.Plugin, _fixture.Npc.ToString(), "virtual_machine_adapter", Adapter("ScriptFloatProperty"));

        Assert.True(result.Applied, result.Message);
        var after = WrittenProperties(_fixture.NpcBody());
        var switched = after[0];
        Assert.Equal("ScriptFloatProperty", switched.GetProperty("MutagenObjectType").GetString());
        Assert.Equal("Switched", switched.GetProperty("Name").GetString());
        Assert.Equal("Removed", switched.GetProperty("Flags").GetString());
        // The incoming leaf's own Data is a float at the fresh instance's default, which the
        // document's serializer leaves out — the int that rode along in data_int is the outgoing
        // leaf's member, dropped rather than carried over.
        Assert.False(switched.TryGetProperty("Data", out _));
        Assert.Equal(before[1].GetRawText(), after[1].GetRawText());
    }

    [Fact]
    public void ScriptPropertyWithoutDiscriminator_IsRefusedAndWritesNothing()
    {
        var before = _fixture.NpcBody();

        var result = _fixture.Service().EditField(
            _fixture.Plugin, _fixture.Npc.ToString(), "virtual_machine_adapter",
            Json("""
                {"version": 6, "object_format": 2, "scripts": [{"name": "S", "flags": "Local",
                 "properties": [{"name": "P", "flags": "Edited", "data_int": 1}]}]}
                """));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.ListElementTypeUnresolved, result.Refusal);
        Assert.Equal(before, _fixture.NpcBody());
    }

    private static List<JsonElement> WrittenProperties(string body) =>
        [.. JsonDocument.Parse(body).RootElement.GetProperty("VirtualMachineAdapter")
            .GetProperty("Scripts")[0].GetProperty("Properties").EnumerateArray()];

    private sealed class ScriptedNpcFixture : IDisposable
    {
        private const string PluginName = "ScriptedNpc701.esp";
        private const string Origin = "ScriptedNpc701Mod";

        private static readonly SchemaReflector VmadReflected = new(category =>
            SchemaAnnotations.For(category) is var a
                ? a with { ExcludedUnions = [.. a.ExcludedUnions.Where(u => u != "AVirtualMachineAdapter")] }
                : throw new InvalidOperationException());

        private readonly string _modFolder = Directory.CreateTempSubdirectory("medit-701-mod-").FullName;
        private readonly string _gameDirectory = Directory.CreateTempSubdirectory("medit-701-game-").FullName;
        private readonly LoadOrderMirror _mirror;

        public PluginKey Plugin { get; } = new(PluginName, Origin);
        public FormKey Npc { get; }

        public ScriptedNpcFixture()
        {
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

            _mirror = new LoadOrderMirror(
                new DuckDbRecordIndexFactory(VmadReflected, new TableDdlBuilder(VmadReflected)));
            ((ILoadOrderMirror)_mirror).Reconcile(
                _gameDirectory, [new LoadOrderEntry(PluginName, pluginPath, Origin, Slot: 0, Enabled: true, Winning: true)],
                GameRelease.Fallout4);
            new TrackService(NullLogger<TrackService>.Instance)
                .TrackAsync(_mirror.LoadOrder!, Origin, SourcePreset.Edits)
                .GetAwaiter().GetResult();
        }

        public RecordEditService Service() =>
            new(_mirror, VmadReflected, NullLogger<RecordEditService>.Instance);

        public string NpcBody() => _mirror.Index!.At(RecordRef.Effective).GetDocument(Npc.ToString(), Plugin)!.Body!;

        public void Dispose()
        {
            _mirror.Dispose();
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
