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
/// Proving tests for <see cref="RecordEditService.EditField"/>'s generic write mechanisms. A passing
/// assertion alone proves nothing (standing rule: a guard test is vacuous until watched fail), so
/// each mechanism's rival implementation was applied and the failure observed.
///
/// <para>Whole-array write and struct/array-nested FormKey write are both exercised by
/// <c>FormLinkValidationTests.PointingAFormLinkAtARecordOfTheRightType_IsAccepted</c>, which
/// sets the NPC's <c>keywords</c> array (a FormLink array — array-write and nested-FormKey-write are
/// literally the same field there) through this exact door and asserts it lands as working-tree
/// dirt. That test is not duplicated here. This file covers the two mechanisms it never
/// exercised: a top-level bitmask enum column, and a condition-owning field's whole-list write.</para>
/// </summary>
public sealed class GenericFieldWriteDispatchTests : IDisposable
{
    private readonly TrackedModFixture _mod = TrackedModFixture.Tracked();
    private readonly ConditionOwnerFixture _cond = new();

    public void Dispose()
    {
        _mod.Dispose();
        _cond.Dispose();
    }

    private RecordEditService Service() =>
        new(_mod.Mirror, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

    private RecordEditService ConditionService() =>
        new(_cond.Mirror, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    [Fact]
    public void EditField_SetsATopLevelBitmaskFlagsColumn()
    {
        Assert.Empty(_mod.GitStatus());

        // Decimal-string encoded, per SchemaReflector.ReadBitmaskLong — survives above 2^53 where a
        // raw JSON number would lose precision. The exact bit pattern doesn't matter to this proof;
        // that the write lands at all through EditField does.
        var result = Service().EditField(_mod.Plugin, _mod.Npc.ToString(), "flags", Json("\"1\""));

        Assert.True(result.Applied, result.Message);
        Assert.NotEmpty(_mod.GitStatus());
    }

    [Fact]
    public void EditField_ReplacesAWholeConditionOwningField()
    {
        Assert.Empty(_cond.GitStatus());

        var result = ConditionService().EditField(
            _cond.Plugin, _cond.Cobj.ToString(), "Conditions",
            Json("""[{"function":"GetIsID","operator":"EqualTo","comparisonFloat":1}]"""));

        Assert.True(result.Applied, result.Message);
        Assert.NotEmpty(_cond.GitStatus());
        var body = _cond.Mirror.Index!.GetDocument(_cond.Cobj.ToString(), _cond.Plugin)!.Body!;
        Assert.Contains("GetIsID", body, StringComparison.Ordinal);
    }

    /// <summary>A record with one <c>Conditions</c>-bearing field (ConstructibleObject, the same
    /// type <c>Fallout4ConditionCodecTests</c> uses for the identical reason) — self-contained
    /// rather than added to <see cref="TrackedModFixture"/>, which is deliberately kept at its
    /// existing three records.</summary>
    private sealed class ConditionOwnerFixture : IDisposable
    {
        private const string PluginName = "CondFixture.esp";
        private const string Origin = "CondFixtureMod";

        public string ModFolder { get; }
        public string GameDirectory { get; }
        public LoadOrderMirror Mirror { get; }
        public PluginKey Plugin { get; } = new(PluginName, Origin);
        public FormKey Cobj { get; }

        public ConditionOwnerFixture()
        {
            ModFolder = Directory.CreateTempSubdirectory("medit-cond-mod-").FullName;
            GameDirectory = Directory.CreateTempSubdirectory("medit-cond-game-").FullName;

            var pluginPath = Path.Combine(ModFolder, PluginName);
            var mod = new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);
            var cobj = mod.ConstructibleObjects.AddNew("FixtureCobj");
            mod.WriteToBinary(pluginPath);
            Cobj = cobj.FormKey;

            Mirror = new LoadOrderMirror(
                new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
            ((ILoadOrderMirror)Mirror).Reconcile(
                GameDirectory,
                [new LoadOrderEntry(PluginName, pluginPath, Origin, Slot: 0, Enabled: true, Winning: true)],
                GameRelease.Fallout4);

            new TrackService(NullLogger<TrackService>.Instance)
                .TrackAsync(Mirror.LoadOrder!, Origin, SourcePreset.Edits)
                .GetAwaiter().GetResult();
        }

        public IReadOnlyList<string> GitStatus() =>
            GitCli.Run(Path.Combine(ModFolder, ".git"), ModFolder, "status", "--porcelain")
                .Split('\n', StringSplitOptions.RemoveEmptyEntries)
                .Select(l => l.Trim())
                .ToList();

        public void Dispose()
        {
            Mirror.Dispose();
            try { Directory.Delete(ModFolder, recursive: true); }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
            try { Directory.Delete(GameDirectory, recursive: true); } catch (IOException) { }
        }
    }
}
