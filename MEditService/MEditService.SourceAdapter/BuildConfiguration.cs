using System.Text.Encodings.Web;
using System.Text.Json;

namespace MEditService.SourceAdapter;

/// <summary>A source mod's build configuration: the mod folder its build writes, by name. The mod manager's record
/// says the installation files.</summary>
internal sealed record BuildConfiguration(string Output)
{
    private static readonly JsonSerializerOptions Spelling = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = true,
        NewLine = "\n",
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    internal static byte[] Of(string output) =>
        [.. JsonSerializer.SerializeToUtf8Bytes(new BuildConfiguration(output), Spelling), (byte)'\n'];
}
