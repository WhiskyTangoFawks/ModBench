using System.Text.Json;
using MEditService.Commands;
using MEditService.Commands.Tests.TestSupport;
using MEditService.TestSupport.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Commands.Tests.Edits;

/// <summary>Whole-array and nested-FormKey writes are already exercised by
/// <c>FormLinkValidationTests</c> through this same door; this file covers the one mechanism it
/// never reached, a top-level bitmask enum column.</summary>
public sealed class GenericFieldWriteDispatchTests : IDisposable
{
    private readonly SourceEditFixture _mod = SourceEditFixture.Tracked();

    public void Dispose() => _mod.Dispose();

    private EditRecordHandler Service() => _mod.EditHandler;

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    [Fact]
    public void EditField_SetsATopLevelBitmaskFlagsColumn()
    {
        Assert.Empty(_mod.GitStatus());

        // The document spells a flags value as its member names, and that is what the codec reads.
        var result = Service().Set(_mod.Plugin, _mod.Npc.ToString(), "Flags", Json("""["Female"]"""));

        Assert.True(result.Applied, result.Message);
        Assert.NotEmpty(_mod.GitStatus());
    }
}
