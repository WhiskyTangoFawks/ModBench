using System.Globalization;
using MEditService.Codec.Schema;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;

namespace MEditService.Codec.Tests.Schema;

public sealed class DeclaredDefaultTests
{
    [Theory]
    [InlineData("npc_", "VirtualMachineAdapter.ObjectFormat", "2")]
    [InlineData("npc_", "VirtualMachineAdapter.Version", "6")]
    [InlineData("npc_", "VirtualMachineAdapter.Scripts.[].Name", null)]
    [InlineData("npc_", "HeightMin", null)]
    [InlineData("npc_", "VirtualMachineAdapter.Scripts.[].Properties.[].Flags", "Edited")]
    [InlineData("cobj", "Conditions.[].Data.RunOnType", "Subject")]
    [InlineData("dial", "Priority", "50")]
    [InlineData("ligh", "Color", "#00000000")]
    [InlineData("mato", "ProjectionVector", "0, 0, 0")]
    [InlineData("race", "Unknown", "0x0000000000000000")]
    public void AFieldsDefault_IsTheOneMutagenDeclaresOrTheCodecsSpellingOfItsZero(string table, string path, string? expected)
    {
        var field = SchemaFields.At(GameRelease.Fallout4, table, path);

        Assert.Equal(expected, field.Default is null ? null : Convert.ToString(field.Default, CultureInfo.InvariantCulture));
    }

    private const string DeclaredDefaultsRefusalPrefix = "SchemaReflector: declared defaults unavailable";

    [Fact]
    public void TheCodecAnswersAnEmptyDocumentForEveryOwnerTheWalkReaches()
    {
        var entries = new List<LogEntry>();
        using var factory = LoggerFactory.Create(b => b.SetMinimumLevel(LogLevel.Debug).AddProvider(new CollectingLoggerProvider(entries)));
        new SchemaReflector(factory.CreateLogger<SchemaReflector>()).GetSchemas(GameRelease.Fallout4);
        Assert.True(entries.Count > 0, "Expected the collector to receive the walk's own trace; a collector wired to nothing would find zero refusals too.");

        var refused = entries.Where(e => e.Message.StartsWith(DeclaredDefaultsRefusalPrefix, StringComparison.Ordinal)).Select(e => e.Message).Distinct().ToList();
        Assert.True(refused.Count == 0, string.Join("\n", refused));
    }
}
