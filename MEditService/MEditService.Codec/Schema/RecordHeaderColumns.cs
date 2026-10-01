using System.Globalization;
using System.Reflection;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Codec.Schema;

/// <summary>One record type's header members as columns, in the annotation table's order, and the
/// document's other spellings of its flags, which are no column of their own.</summary>
internal static class RecordHeaderColumns
{
    private const string FlagsMember = nameof(IMajorRecordGetter.MajorRecordFlagsRaw);

    // Every bit, so each flag view Mutagen spells over the raw integer shows up.
    private const long AllBits = -1;

    internal static (List<ColumnSpec> Columns, IReadOnlyList<string> Aliases) For(
        Type getterType, GameReflection game, ILogger logger)
    {
        var properties = ReflectedTypes.GetAllInterfaceProperties(getterType)
            .GroupBy(p => p.Name, StringComparer.Ordinal)
            .ToDictionary(g => g.Key, ReflectedTypes.MostDerived, StringComparer.Ordinal);
        var aliases = game.Defaults.MembersAliasing(getterType, FlagsMember, AllBits);

        var columns = new List<ColumnSpec>();
        foreach (var (_, member, label) in game.Annotations.RecordHeaderMembers)
        {
            if (!properties.TryGetValue(member, out var prop)) continue;
            if (ColumnReflection.BuildColumn(prop, prop.Name, game, logger) is not { } column) continue;

            var field = column.Field with { DisplayLabel = label, IsRecordHeaderMember = true };
            columns.Add(member == FlagsMember
                ? column with { Field = field with { EnumMembers = FlagNames(aliases, properties) }, Aliases = aliases }
                : column with { Field = field });
        }
        return (columns, aliases);
    }

    // The bits every flags view over the raw integer names, in bit order. Where the game's view and
    // the record type's own name one bit, the type's narrower word stands.
    private static List<EnumMember> FlagNames(IReadOnlyList<string> aliases, Dictionary<string, PropertyInfo> properties)
    {
        var views = aliases
            .Select(properties.GetValueOrDefault)
            .OfType<PropertyInfo>()
            .Select(p => (Declaring: ReflectedTypes.DeclaringTypeOf(p), Core: ReflectedTypes.CoreOf(p).Core))
            .Where(v => v.Core.IsEnum && v.Core.GetCustomAttribute<FlagsAttribute>() != null)
            .OrderBy(v => v.Declaring.GetInterfaces().Length);

        var byBit = new SortedDictionary<long, EnumMember>();
        foreach (var view in views)
        {
            foreach (var member in LeafClassification.GetEnumMembers(view.Core))
            {
                if (member.BitValue is { } bit) byBit[long.Parse(bit, CultureInfo.InvariantCulture)] = member;
            }
        }
        return [.. byBit.Values];
    }
}
