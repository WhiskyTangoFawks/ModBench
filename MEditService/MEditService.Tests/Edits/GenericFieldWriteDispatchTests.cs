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
/// dirt. That test is not duplicated here. This file covers the one mechanism it never
/// exercised: a top-level bitmask enum column.</para>
/// </summary>
public sealed class GenericFieldWriteDispatchTests : IDisposable
{
    private readonly TrackedModFixture _mod = TrackedModFixture.Tracked();

    public void Dispose() => _mod.Dispose();

    private RecordEditService Service() =>
        new(_mod.Mirror, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    [Fact]
    public void EditField_SetsATopLevelBitmaskFlagsColumn()
    {
        Assert.Empty(_mod.GitStatus());

        // Decimal-string encoded, per LeafClassification.ReadBitmaskLong — survives above 2^53 where a
        // raw JSON number would lose precision. The exact bit pattern doesn't matter to this proof;
        // that the write lands at all through EditField does.
        var result = Service().EditField(_mod.Plugin, _mod.Npc.ToString(), "flags", Json("\"1\""));

        Assert.True(result.Applied, result.Message);
        Assert.NotEmpty(_mod.GitStatus());
    }
}
