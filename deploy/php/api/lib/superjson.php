<?php
/**
 * Minimal superjson encoder for tRPC responses: the dashboard's tRPC client uses the superjson
 * transformer, so Dates must be sent as ISO strings plus a meta entry naming their paths.
 */

declare(strict_types=1);

function superjson_escape_key(string $key): string
{
    return str_replace('.', '\\.', str_replace('\\', '\\\\', $key));
}

function superjson_walk($value, array $path, array &$dates)
{
    if ($value instanceof DateTimeInterface) {
        $dates[] = $path;
        return $value->format('Y-m-d\TH:i:s.v\Z');
    }
    if (is_array($value)) {
        $out = [];
        foreach ($value as $k => $v) $out[$k] = superjson_walk($v, array_merge($path, [(string) $k]), $dates);
        return $out;
    }
    if ($value instanceof stdClass) {
        $out = new stdClass();
        foreach (get_object_vars($value) as $k => $v) $out->$k = superjson_walk($v, array_merge($path, [(string) $k]), $dates);
        return $out;
    }
    return $value;
}

/** Returns ['json' => ..., 'meta' => ['values' => ...]] (meta only when there are Dates). */
function superjson_serialize($value): array
{
    $dates = [];
    $json = superjson_walk($value, [], $dates);
    $result = ['json' => $json];
    if (!$dates) return $result;
    if ($dates === [[]]) {
        $result['meta'] = ['values' => ['Date']];
        return $result;
    }
    $values = [];
    foreach ($dates as $path) $values[implode('.', array_map('superjson_escape_key', $path))] = ['Date'];
    $result['meta'] = ['values' => $values];
    return $result;
}
