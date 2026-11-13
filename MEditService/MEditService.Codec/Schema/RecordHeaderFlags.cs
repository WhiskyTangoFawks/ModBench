using System.Collections.Concurrent;
using System.Text.Json;
using MEditService.Codec.Serialization;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Codec.Schema;

/// <summary>The record header's flags as the document carries them: one integer member.</summary>
public static class RecordHeaderFlags
{
    public const string Member = nameof(IMajorRecordGetter.MajorRecordFlagsRaw);

    // Every bit, so each flag view Mutagen spells over the raw integer shows up.
    internal const long AllBits = -1;

    private static readonly ConcurrentDictionary<(Type Record, GameRelease Release), IReadOnlyList<string>> Views = new();

    /// <summary>The members that spell the flags again on <paramref name="recordClass"/>: the aliases of its
    /// flags column.</summary>
    internal static IReadOnlyList<string> ViewsOf(Type recordClass, GameRelease release) =>
        Views.GetOrAdd((recordClass, release), key =>
            ReflectedTypes.GetOwnGetterType(key.Record) is { } getter
                ? new DeclaredDefaults(key.Release, NullLogger.Instance).MembersAliasing(getter, Member, AllBits)
                : []);

    /// <summary>A document omits the member when no bit is set.</summary>
    internal static bool Carry(JsonElement document, int bit) => Document.OfRecord(document).CarriesHeaderFlag(bit);
}
